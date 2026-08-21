#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
ensure_postgres

unset DATABASE_URL
export DATABASE_URL="$(lab_database_url)"
node "$LAB_REPO/packages/db-schema/scripts/migrate.mjs" verify
unset DATABASE_URL

start_orch
wait_http "http://127.0.0.1:$LAB_ORCH_PORT/api/health"
start_node
wait_http "http://127.0.0.1:$LAB_NODE_PORT/health"
wait_for_node_registration
printf 'lab stack ready: orch=%s node=%s postgres=%s\n' \
  "$LAB_ORCH_PORT" "$LAB_NODE_PORT" "$LAB_POSTGRES_PORT"
