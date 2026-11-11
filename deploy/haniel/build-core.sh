#!/usr/bin/env bash
set -euo pipefail

# macOS has no GNU realpath/flock/free/timeout and no fixed /home/eias account,
# so a Darwin build hook hands the whole pipeline to a Python runner instead.
if [[ "$(uname -s)" == "Darwin" ]]; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  exec python3 "$script_dir/build_core_darwin.py"
fi

script_dir="$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")"
# Haniel may call this from a node-specific checkout; the account paths below
# intentionally match the host that owns this build hook.
app_dir="$(realpath -- "$script_dir/../..")"
deploy_lock_file=/tmp/soulstream-heavy-verify.deploy.lock
deploy_lock_wait_seconds=300
minimum_available_mb=2000

available_memory_mb() {
  free -m | awk '/^Mem:/ { print $7 }'
}

require_available_memory() {
  local available_mb
  available_mb="$(available_memory_mb)"
  if [[ "$available_mb" =~ ^[0-9]+$ ]] && (( available_mb >= minimum_available_mb )); then
    return
  fi

  printf 'Available memory is below %s MiB; waiting 60 seconds before retrying.\n' "$minimum_available_mb" >&2
  sleep 60
  available_mb="$(available_memory_mb)"
  if [[ ! "$available_mb" =~ ^[0-9]+$ ]] || (( available_mb < minimum_available_mb )); then
    printf 'Refusing build: need at least %s MiB available memory.\n' "$minimum_available_mb" >&2
    exit 1
  fi
}

run_heavy_command() {
  require_available_memory
  (
    # Corepack reads packageManager from the current checkout root.
    cd "$app_dir"
    timeout 900 \
      env -i \
      HOME=/home/eias \
      USER=eias \
      LOGNAME=eias \
      SHELL=/bin/bash \
      PATH=/home/eias/.local/bin:/home/eias/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      NODE_ENV=production \
      COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      "$@"
  )
}

run_heavy_pnpm() {
  run_heavy_command corepack pnpm "$@"
}

# Portable node release pack (P7a): only the host that serves portable releases
# sets PORTABLE_NODE_RELEASES_DIR. The pack builds a clean shared clone of the
# deployed commit, so it must never fail the deploy: warn in one line and keep
# going. The deploy build lock (fd 9) is already held here.
run_portable_release_pack() {
  if [[ -z "${PORTABLE_NODE_RELEASES_DIR:-}" ]]; then
    return 0
  fi

  printf 'Packing the portable node release into %s\n' "$PORTABLE_NODE_RELEASES_DIR" >&2
  if (
    # A subshell keeps a memory-check abort inside this step, not the deploy.
    run_heavy_command bash "$script_dir/pack_portable_node_release.sh" \
      "$app_dir" "$PORTABLE_NODE_RELEASES_DIR"
  ); then
    return 0
  fi

  printf 'WARNING: portable node release pack failed; continuing the deploy.\n' >&2
  return 0
}

# The deploy build outranks agent verification (card #1238): it no longer waits
# on the host heavy-verify gate that a 40-minute e2e can hold. While this build
# holds the deploy build lock, heavy_verify.py starts no new command and waits;
# commands already running keep running. The wait is capped far below Haniel's
# 900-second hook limit, so a timed-out hook cannot leave a blocked flock behind.
# Hold the lock once for the whole build: taking it per step lets other builds
# slip in between steps and makes the next step wait again. Children inherit
# fd 9, so the lock holds until the last step finishes.
printf 'Waiting for the deploy build lock %s\n' "$deploy_lock_file" >&2
exec 9>"$deploy_lock_file"
if ! flock -w "$deploy_lock_wait_seconds" 9; then
  printf 'Refusing build: the deploy build lock %s stayed busy for %s seconds.\n' "$deploy_lock_file" "$deploy_lock_wait_seconds" >&2
  exit 1
fi

run_heavy_pnpm install --frozen-lockfile --prod=false
run_heavy_pnpm --filter @soulstream/soul-server-ts exec env SOULSTREAM_RELEASE_ENV_FILE="$app_dir/.env.soul-server-ts" pnpm run build
run_heavy_pnpm --filter @soulstream/orch-server-ts run build
run_heavy_pnpm --dir "$app_dir/unified-dashboard" run build
run_heavy_command npm --prefix "$app_dir/soul-app" ci --include=dev --no-audit --no-fund
run_heavy_command npm --prefix "$app_dir/soul-app" run export:components

test -f "$app_dir/soul-server-ts/dist/main.js"
test -f "$app_dir/orch-server-ts/dist/production_main.js"
test -f "$app_dir/unified-dashboard/dist/index.html"
test -f "$app_dir/unified-dashboard/dist/build-info.json"
test -f "$app_dir/unified-dashboard/dist/assets/ios-components/index.html"

run_portable_release_pack
