#!/usr/bin/env bash
set -euo pipefail

script_dir="$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")"
# Haniel may call this from a node-specific checkout; the account paths below
# intentionally match the host that owns this build hook.
app_dir="$(realpath -- "$script_dir/../..")"
lock_file=/tmp/soulstream-heavy-verify.lock
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
    timeout 900 flock "$lock_file" \
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

run_heavy_pnpm install --frozen-lockfile --prod=false
run_heavy_pnpm --filter @soulstream/soul-server-ts exec env SOULSTREAM_RELEASE_ENV_FILE="$app_dir/.env.soul-server-ts" pnpm run build
run_heavy_pnpm --filter @soulstream/orch-server-ts run build
run_heavy_pnpm --dir "$app_dir/unified-dashboard" run build
run_heavy_command npm --prefix "$app_dir/soul-app" ci --include=dev --no-audit --no-fund
run_heavy_command npm --prefix "$app_dir/soul-app" run export:components

test -f "$app_dir/soul-server-ts/dist/main.js"
test -f "$app_dir/orch-server-ts/dist/production_main.js"
test -f "$app_dir/unified-dashboard/dist/index.html"
test -f "$app_dir/unified-dashboard/dist/assets/ios-components/index.html"
