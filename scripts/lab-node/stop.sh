#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
stop_owned_process \
  lab-node "$LAB_ROOT/state/node.pid" "$LAB_REPO/soul-server-ts/dist/main.js"
stop_owned_process \
  lab-orch "$LAB_ROOT/state/orch.pid" "$LAB_REPO/orch-server-ts/dist/production_main.js"

if docker container inspect "$LAB_POSTGRES_CONTAINER" >/dev/null 2>&1; then
  postgres_container_is_owned || fail "refusing to stop an unowned postgres container"
  docker stop "$LAB_POSTGRES_CONTAINER" >/dev/null
  printf 'lab-postgres stopped\n'
fi
