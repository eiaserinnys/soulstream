#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_lab_env
status=0

if docker container inspect "$LAB_POSTGRES_CONTAINER" >/dev/null 2>&1 \
  && postgres_container_is_owned \
  && [[ "$(docker inspect --format '{{.State.Running}}' "$LAB_POSTGRES_CONTAINER")" == "true" ]]; then
  printf 'postgres: running (%s)\n' "$LAB_POSTGRES_CONTAINER"
else
  printf 'postgres: stopped or missing\n'
  status=1
fi

if pid_is_running "$LAB_ROOT/state/orch.pid"; then
  printf 'orch: running (pid %s, port %s)\n' "$(<"$LAB_ROOT/state/orch.pid")" "$LAB_ORCH_PORT"
else
  printf 'orch: stopped\n'
  status=1
fi

if pid_is_running "$LAB_ROOT/state/node.pid"; then
  printf 'node: running (pid %s, port %s)\n' "$(<"$LAB_ROOT/state/node.pid")" "$LAB_NODE_PORT"
else
  printf 'node: stopped\n'
  status=1
fi

if curl -fsS "http://127.0.0.1:$LAB_ORCH_PORT/api/health" >/dev/null 2>&1; then
  printf 'orch health: ok\n'
else
  printf 'orch health: failed\n'
  status=1
fi

if curl -fsS "http://127.0.0.1:$LAB_NODE_PORT/health" >/dev/null 2>&1; then
  printf 'node health: ok\n'
else
  printf 'node health: failed\n'
  status=1
fi

nodes_file="$LAB_ROOT/state/nodes.json"
if api_get_to_file /api/nodes "$nodes_file" 2>/dev/null; then
  node_count="$(node -e '
    const fs = require("node:fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const count = Array.isArray(body.nodes)
      ? body.nodes.filter((node) => node && node.nodeId === "eias-lab").length
      : 0;
    process.stdout.write(String(count));
  ' "$nodes_file")"
  printf 'eias-lab registry count: %s\n' "$node_count"
  [[ "$node_count" == "1" ]] || status=1
else
  printf 'eias-lab registry count: unavailable\n'
  status=1
fi

if docker container inspect "$LAB_POSTGRES_CONTAINER" >/dev/null 2>&1 \
  && postgres_container_is_owned; then
  heartbeat_count="$(lab_psql -Atc \
    "SELECT COUNT(*) FROM soulstream_node_heartbeats WHERE node_id = 'eias-lab'" 2>/dev/null || true)"
  printf 'eias-lab heartbeat count: %s\n' "${heartbeat_count:-unavailable}"
  [[ "$heartbeat_count" == "1" ]] || status=1
fi

exit "$status"
