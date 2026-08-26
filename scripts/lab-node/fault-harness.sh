#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
export LAB_ROOT
export LAB_INTERVENTION_ACCEPTANCE_TIMEOUT_MS=$((LAB_INTERVENTION_ACCEPTANCE_SECONDS * 1000))
export LAB_HARNESS_PROCESS_CEILING_SECONDS
harness_entry="$LAB_REPO/scripts/lab-node/fault-harness.mjs"
suite_entry="$LAB_REPO/scripts/lab-node/fault-harness-suite.mjs"

if [[ "${1:-}" == "all" || "${1:-}" == "faults" ]]; then
  if [[ "${SOULSTREAM_HEAVY_LOCK_HELD:-}" == "1" ]]; then
    /usr/bin/node "$suite_entry" "$1"
  else
    export SOULSTREAM_HEAVY_LOCK_HELD=1
    flock -w 300 /tmp/soulstream-heavy-verify.lock \
      /usr/bin/node "$suite_entry" "$1"
  fi
  exit
fi

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
