#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
export LAB_ROOT
export LAB_INTERVENTION_ACCEPTANCE_TIMEOUT_MS=$((LAB_INTERVENTION_ACCEPTANCE_SECONDS * 1000))
harness_entry="$LAB_REPO/scripts/lab-node/fault-harness.mjs"
if [[ "${SOULSTREAM_HEAVY_LOCK_HELD:-}" == "1" ]]; then
  run_with_process_group_ceiling \
    "$LAB_HARNESS_PROCESS_CEILING_SECONDS" "$harness_entry" \
    /usr/bin/node "$harness_entry" "$@"
else
  export SOULSTREAM_HEAVY_LOCK_HELD=1
  run_with_process_group_ceiling \
    "$LAB_HARNESS_PROCESS_CEILING_SECONDS" "$harness_entry" \
    flock -w 300 /tmp/soulstream-heavy-verify.lock \
    /usr/bin/node "$harness_entry" "$@"
fi
