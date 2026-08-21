#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
wait_for_node_registration

api_base="http://127.0.0.1:$LAB_ORCH_PORT"
state_dir="$LAB_ROOT/state/smoke"
mkdir -p "$state_dir"
create_response="$state_dir/create.json"
timeline_response="$state_dir/timeline.json"
intervene_response="$state_dir/intervene.json"
timeout_seconds="${LAB_SMOKE_TIMEOUT_SECONDS:-600}"

curl -fsS \
  -H "Authorization: Bearer $LAB_AUTH_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"profile":"lab-claude","model_preset":"claude-sonnet","prompt":"Reply with exactly LAB_TURN_1_OK."}' \
  "$api_base/api/sessions" >"$create_response"

session_id="$(node -e '
  const fs = require("node:fs");
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof body.agentSessionId !== "string") process.exit(1);
  process.stdout.write(body.agentSessionId);
' "$create_response")"
printf '%s\n' "$session_id" >"$LAB_ROOT/state/last-smoke-session"
printf 'created session: %s\n' "$session_id"

wait_for_marker() {
  local marker="$1"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if curl -fsS \
      -H "Authorization: Bearer $LAB_AUTH_BEARER_TOKEN" \
      "$api_base/api/sessions/$session_id/timeline?limit=200&event_types=assistant_message" \
      >"$timeline_response" 2>/dev/null \
      && node -e '
        const fs = require("node:fs");
        const text = fs.readFileSync(process.argv[1], "utf8");
        process.exit(text.includes(process.argv[2]) ? 0 : 1);
      ' "$timeline_response" "$marker"; then
      printf 'observed assistant marker: %s\n' "$marker"
      return 0
    fi
    sleep 5
  done
  fail "assistant marker not observed before timeout: $marker"
}

wait_for_marker LAB_TURN_1_OK
"$SCRIPT_DIR/restart-node.sh"

curl -fsS \
  -H "Authorization: Bearer $LAB_AUTH_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply with exactly LAB_TURN_2_OK.","user":"lab-smoke","delivery_intent":"durable_next_turn","source":"lab-smoke"}' \
  "$api_base/api/sessions/$session_id/intervene" >"$intervene_response"

wait_for_marker LAB_TURN_2_OK
printf 'lab smoke passed for session %s\n' "$session_id"
