#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
# shellcheck source=clean-run-common.sh
source "$SCRIPT_DIR/clean-run-common.sh"

if [[ "${SOULSTREAM_HEAVY_LOCK_HELD:-}" != "1" ]]; then
  require_command flock
  wait_for_lab_memory
  export SOULSTREAM_HEAVY_LOCK_HELD=1
  exec flock -w 300 /tmp/soulstream-heavy-verify.lock "$0" "$@"
fi

load_lab_env
print_fresh_lab_provenance
stop_lab_for_reset
remove_lab_postgres
reset_lab_mutable_state

activate_rollback_mutation="${LAB_ACTIVATE_ROLLBACK_MUTATION:-}"
h2_mutation_backup="$LAB_ROOT/state/h2-product-mutation.json"

cleanup() {
  local status="$?"
  trap - EXIT
  "$SCRIPT_DIR/stop.sh" || status=1
  if [[ -f "$h2_mutation_backup" ]]; then
    node "$SCRIPT_DIR/fault-h2-product-mutation.mjs" \
      restore "$LAB_REPO" "$h2_mutation_backup" || status=1
    git -C "$LAB_REPO" diff --exit-code -- \
      soul-server-ts/src/task/task_executor.ts || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ "$activate_rollback_mutation" == "cleanup_removed" ]]; then
  node "$SCRIPT_DIR/fault-h2-product-mutation.mjs" \
    apply "$LAB_REPO" "$h2_mutation_backup"
fi

export LAB_CLAUDE_AUTH_SOURCE="$LAB_CLAUDE_AUTH_FILE"
"$SCRIPT_DIR/bootstrap.sh"
"$SCRIPT_DIR/start.sh"

if (( $# == 0 )); then
  set -- all
fi
"$SCRIPT_DIR/fault-harness.sh" "$@"
