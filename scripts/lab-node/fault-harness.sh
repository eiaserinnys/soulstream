#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
export LAB_ROOT
export SOULSTREAM_HEAVY_LOCK_HELD=1
exec flock -w 300 /tmp/soulstream-heavy-verify.lock \
  timeout 1800s /usr/bin/node "$LAB_REPO/scripts/lab-node/fault-harness.mjs" "$@"
