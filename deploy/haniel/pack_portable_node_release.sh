#!/usr/bin/env bash
set -euo pipefail

# Pack the portable node release for the deployed commit into the folder the
# orchestrator serves. deploy/haniel/build-core.sh calls this after its own
# build and artifact checks with the app checkout and the release folder. The
# caller already holds the host heavy-work lock (fd 9), so this script must not
# take it again; a failure here warns but never fails the deploy.

usage() {
  printf 'usage: pack_portable_node_release.sh <app-checkout> <releases-dir>\n' >&2
  exit 2
}

if (( $# != 2 )); then
  usage
fi

app_dir="$(realpath -- "$1")"
mkdir -p -- "$2"
releases_dir="$(realpath -- "$2")"

stage_dir=
work_dir=

prune_releases() {
  local keep_commit="$1"
  local kept=0
  local entry name
  while IFS= read -r entry; do
    name="${entry#* }"
    if [[ -z "$name" || ! "$name" =~ ^[0-9a-f]{40}$ ]]; then
      continue
    fi
    if [[ "$name" == "$keep_commit" ]]; then
      continue
    fi
    kept=$((kept + 1))
    if (( kept > 3 )); then
      rm -rf -- "$releases_dir/$name"
      printf 'pack-portable-node-release: pruned %s\n' "$name" >&2
    fi
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -printf '%T@ %f\n' | sort -rn)
}

cleanup() {
  local status=$?
  if [[ -n "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
  if [[ -n "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
  if (( status == 0 )); then
    printf 'pack-portable-node-release: finished in %ss\n' "$SECONDS" >&2
  else
    printf 'pack-portable-node-release: failed after %ss\n' "$SECONDS" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

commit="$(timeout 30 git -C "$app_dir" rev-parse --verify HEAD)"
release_dir="$releases_dir/$commit"

if [[ -f "$release_dir/node.tar.gz" && -f "$release_dir/node.tar.gz.sha256" ]]; then
  printf 'pack-portable-node-release: %s is already packed; skipping\n' "$commit" >&2
  prune_releases "$commit"
  exit 0
fi

stage_dir="$releases_dir/.stage-$$"
work_dir="$(mktemp -d "$releases_dir/.pack-work.XXXXXX")"
clone_dir="$work_dir/clone"

# Never pack the live checkout: operator files that the pack's clean-tree gate
# refuses can live there, and its build would overwrite the dist and
# release-manifest.json the running service reads. A shared clone of the same
# HEAD is clean and throwaway; the pack verifies that HEAD itself.
timeout 120 git clone --shared --no-checkout --quiet "$app_dir" "$clone_dir"
timeout 60 git -C "$clone_dir" checkout --quiet --detach "$commit"

(
  cd "$clone_dir"
  timeout 240 corepack pnpm install --frozen-lockfile --prod=false
)
(
  cd "$clone_dir"
  # The pack's build writes a release manifest exactly like build-core's own
  # build, and that build needs the deployed env document. The clone has no
  # untracked .env.soul-server-ts, so point it at the deployed checkout's one.
  SOULSTREAM_RELEASE_ENV_FILE="$app_dir/.env.soul-server-ts" \
    timeout 300 corepack pnpm --filter @soulstream/soul-server-ts run pack:portable --out "$stage_dir"
)

packed_dir="$stage_dir/$commit"
if [[ ! -f "$packed_dir/node.tar.gz" || ! -f "$packed_dir/node.tar.gz.sha256" ]]; then
  printf 'pack-portable-node-release: pack left no node.tar.gz and node.tar.gz.sha256 for %s\n' "$commit" >&2
  exit 1
fi

# Publish atomically: an incomplete folder from an earlier attempt must not
# make the rename nest the new folder inside it.
if [[ -e "$release_dir" ]]; then
  rm -rf -- "$release_dir"
fi
mv -- "$packed_dir" "$release_dir"
printf 'pack-portable-node-release: published %s\n' "$commit" >&2
prune_releases "$commit"
