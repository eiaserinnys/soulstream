#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
stop_owned_process \
  lab-node "$LAB_ROOT/state/node.pid" "$LAB_REPO/soul-server-ts/dist/main.js"
start_node
wait_http "http://127.0.0.1:$LAB_NODE_PORT/health"
wait_for_node_registration
printf 'lab node restarted and registered\n'
