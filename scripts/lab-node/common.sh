#!/usr/bin/env bash
set -euo pipefail

LAB_DEFAULT_ROOT=/home/eias/services/soulstream-lab
LAB_SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
LAB_REPO_ROOT="$(git -C "$LAB_SCRIPT_DIR/../.." rev-parse --show-toplevel)"
LAB_ROOT="${SOULSTREAM_LAB_ROOT:-$LAB_DEFAULT_ROOT}"
LAB_ENV_FILE="$LAB_ROOT/.env"

fail() {
  printf 'lab-node: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_value() {
  local key="$1"
  [[ -n "${!key:-}" ]] || fail "$key is required in $LAB_ENV_FILE"
}

load_lab_env() {
  [[ -f "$LAB_ENV_FILE" ]] || fail "missing $LAB_ENV_FILE; run bootstrap.sh first"
  set -a
  # shellcheck disable=SC1090
  source "$LAB_ENV_FILE"
  set +a
  validate_lab_identity
}

validate_lab_identity() {
  local key
  for key in \
    LAB_REPO LAB_ORCH_PORT LAB_NODE_PORT LAB_POSTGRES_PORT \
    LAB_POSTGRES_CONTAINER LAB_POSTGRES_VOLUME LAB_POSTGRES_DB \
    LAB_POSTGRES_USER LAB_POSTGRES_PASSWORD LAB_AUTH_BEARER_TOKEN \
    LAB_JWT_SECRET LAB_CLAUDE_AUTH_FILE; do
    require_value "$key"
  done

  [[ "$LAB_ROOT" == "$LAB_DEFAULT_ROOT" ]] || fail "LAB_ROOT must be $LAB_DEFAULT_ROOT"
  [[ "$LAB_REPO" == "$LAB_ROOT/repo" ]] || fail "LAB_REPO must be $LAB_ROOT/repo"
  [[ "$LAB_REPO_ROOT" == "$LAB_REPO" ]] || fail "run this script from the dedicated runtime clone at $LAB_REPO"
  [[ "$LAB_REPO_ROOT" != *"/.projects/"* ]] || fail "lab runtime must not use a worktree"
  [[ "$LAB_POSTGRES_CONTAINER" == soulstream-lab-* ]] || fail "unsafe postgres container name"
  [[ "$LAB_POSTGRES_VOLUME" == soulstream-lab-* ]] || fail "unsafe postgres volume name"
  [[ "$LAB_POSTGRES_DB" == soulstream_lab* ]] || fail "unsafe postgres database name"
  [[ "$LAB_POSTGRES_USER" == soulstream_lab* ]] || fail "unsafe postgres user"
  [[ "$LAB_POSTGRES_PASSWORD" =~ ^[a-f0-9]{32,}$ ]] || fail "postgres password must be generated hex"

  assert_safe_port "$LAB_ORCH_PORT" 5200
  assert_safe_port "$LAB_NODE_PORT" 3105
  assert_safe_port "$LAB_POSTGRES_PORT" 5432 5433 5434 5435 5436
  [[ "$LAB_ORCH_PORT" != "$LAB_NODE_PORT" ]] || fail "orch and node ports must differ"
  [[ "$LAB_ORCH_PORT" != "$LAB_POSTGRES_PORT" ]] || fail "orch and postgres ports must differ"
  [[ "$LAB_NODE_PORT" != "$LAB_POSTGRES_PORT" ]] || fail "node and postgres ports must differ"
}

assert_safe_port() {
  local candidate="$1"
  shift
  [[ "$candidate" =~ ^[0-9]+$ ]] || fail "port is not an integer: $candidate"
  (( candidate > 1024 && candidate < 65536 )) || fail "port is outside the allowed range: $candidate"
  local protected
  for protected in "$@"; do
    [[ "$candidate" != "$protected" ]] || fail "protected production port selected: $candidate"
  done
}

lab_database_url() {
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s' \
    "$LAB_POSTGRES_USER" "$LAB_POSTGRES_PASSWORD" \
    "$LAB_POSTGRES_PORT" "$LAB_POSTGRES_DB"
}

port_is_listening() {
  ss -H -ltn "sport = :$1" | grep -q .
}

assert_port_free() {
  port_is_listening "$1" && fail "port $1 is already listening"
}

postgres_container_is_owned() {
  [[ "$(docker inspect --format '{{ index .Config.Labels "com.soulstream.lab" }}' "$LAB_POSTGRES_CONTAINER" 2>/dev/null || true)" == "true" ]]
}

ensure_postgres() {
  require_command docker
  if docker container inspect "$LAB_POSTGRES_CONTAINER" >/dev/null 2>&1; then
    postgres_container_is_owned || fail "container name exists without com.soulstream.lab=true"
    if [[ "$(docker inspect --format '{{.State.Running}}' "$LAB_POSTGRES_CONTAINER")" != "true" ]]; then
      docker start "$LAB_POSTGRES_CONTAINER" >/dev/null
    fi
  else
    assert_port_free "$LAB_POSTGRES_PORT"
    if docker volume inspect "$LAB_POSTGRES_VOLUME" >/dev/null 2>&1; then
      [[ "$(docker volume inspect --format '{{ index .Labels "com.soulstream.lab" }}' "$LAB_POSTGRES_VOLUME")" == "true" ]] \
        || fail "volume name exists without com.soulstream.lab=true"
    else
      docker volume create --label com.soulstream.lab=true "$LAB_POSTGRES_VOLUME" >/dev/null
    fi
    docker run -d \
      --name "$LAB_POSTGRES_CONTAINER" \
      --label com.soulstream.lab=true \
      --restart no \
      -e POSTGRES_DB="$LAB_POSTGRES_DB" \
      -e POSTGRES_USER="$LAB_POSTGRES_USER" \
      -e POSTGRES_PASSWORD="$LAB_POSTGRES_PASSWORD" \
      -p "127.0.0.1:$LAB_POSTGRES_PORT:5432" \
      -v "$LAB_POSTGRES_VOLUME:/var/lib/postgresql/data" \
      postgres:16-alpine >/dev/null
  fi

  local attempt
  for attempt in $(seq 1 30); do
    if docker exec "$LAB_POSTGRES_CONTAINER" \
      pg_isready -U "$LAB_POSTGRES_USER" -d "$LAB_POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "postgres did not become ready"
}

lab_psql() {
  docker exec "$LAB_POSTGRES_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$LAB_POSTGRES_USER" -d "$LAB_POSTGRES_DB" "$@"
}

pid_is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

pid_matches_entrypoint() {
  local pid="$1"
  local entrypoint="$2"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq "$entrypoint"
}

start_background() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  local entrypoint="$4"
  shift 4

  if pid_is_running "$pid_file"; then
    local existing_pid
    existing_pid="$(<"$pid_file")"
    pid_matches_entrypoint "$existing_pid" "$entrypoint" \
      || fail "$name pid file points to a foreign process"
    printf '%s already running (pid %s)\n' "$name" "$existing_pid"
    return 0
  fi

  mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")"
  local temporary_pid_file="$pid_file.tmp"
  (
    cd "$LAB_REPO"
    nohup "$@" >>"$log_file" 2>&1 &
    printf '%s\n' "$!" >"$temporary_pid_file"
  )
  mv "$temporary_pid_file" "$pid_file"
  sleep 1
  pid_is_running "$pid_file" || fail "$name exited during startup; inspect $log_file"
  printf '%s started (pid %s)\n' "$name" "$(<"$pid_file")"
}

stop_owned_process() {
  local name="$1"
  local pid_file="$2"
  local entrypoint="$3"
  if ! pid_is_running "$pid_file"; then
    rm -f "$pid_file"
    printf '%s is not running\n' "$name"
    return 0
  fi

  local pid
  pid="$(<"$pid_file")"
  pid_matches_entrypoint "$pid" "$entrypoint" \
    || fail "$name pid file points to a foreign process; refusing SIGTERM"
  kill -TERM "$pid"
  local attempt
  for attempt in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
      printf '%s stopped\n' "$name"
      return 0
    fi
    sleep 1
  done
  fail "$name did not stop after 30 seconds; no SIGKILL was sent"
}

start_orch() {
  local entrypoint="$LAB_REPO/orch-server-ts/dist/production_main.js"
  [[ -f "$entrypoint" ]] || fail "orch build missing; run bootstrap.sh"
  if ! pid_is_running "$LAB_ROOT/state/orch.pid"; then
    assert_port_free "$LAB_ORCH_PORT"
  fi
  start_background \
    lab-orch "$LAB_ROOT/state/orch.pid" "$LAB_ROOT/logs/orch.log" "$entrypoint" \
    env -i \
      HOME="$HOME" USER="${USER:-eias}" LOGNAME="${LOGNAME:-eias}" PATH="$PATH" \
      NODE_ENV=production ENVIRONMENT=production NODE_NAME=eias-lab-orch \
      HOST=127.0.0.1 PORT="$LAB_ORCH_PORT" DATABASE_URL="$(lab_database_url)" \
      AUTH_BEARER_TOKEN="$LAB_AUTH_BEARER_TOKEN" \
      JWT_SECRET="$LAB_JWT_SECRET" \
      CORS_ALLOWED_ORIGINS="http://127.0.0.1:$LAB_ORCH_PORT" \
      CLAUDE_OAUTH_CLIENT_ID=lab-disabled \
      CLAUDE_OAUTH_CALLBACK_URL="http://127.0.0.1:$LAB_ORCH_PORT/api/nodes/claude-auth/callback" \
      ATOM_ENABLED=false SOUL_RUNNER_PROCESS_ENABLED=true \
      SOUL_RUNNER_LEASE_TIMEOUT_MS=1800000 \
      /usr/bin/node "$entrypoint"
}

start_node() {
  local entrypoint="$LAB_REPO/soul-server-ts/dist/main.js"
  [[ -f "$entrypoint" ]] || fail "worker build missing; run bootstrap.sh"
  [[ -f "$LAB_REPO/.env.soul-server-ts" ]] || fail "worker env missing; run bootstrap.sh"
  if ! pid_is_running "$LAB_ROOT/state/node.pid"; then
    assert_port_free "$LAB_NODE_PORT"
  fi
  start_background \
    lab-node "$LAB_ROOT/state/node.pid" "$LAB_ROOT/logs/node.log" "$entrypoint" \
    env -i \
      HOME="$HOME" USER="${USER:-eias}" LOGNAME="${LOGNAME:-eias}" PATH="$PATH" \
      NODE_ENV=production \
      /usr/bin/node "$entrypoint"
}

wait_http() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "health check timed out: $url"
}

api_get_to_file() {
  local path="$1"
  local output="$2"
  curl -fsS \
    -H "Authorization: Bearer $LAB_AUTH_BEARER_TOKEN" \
    "http://127.0.0.1:$LAB_ORCH_PORT$path" >"$output"
}

wait_for_node_registration() {
  local response="$LAB_ROOT/state/nodes.json"
  local attempt
  for attempt in $(seq 1 60); do
    if api_get_to_file /api/nodes "$response" 2>/dev/null \
      && node -e '
        const fs = require("node:fs");
        const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const count = Array.isArray(body.nodes)
          ? body.nodes.filter((node) => node && node.nodeId === "eias-lab").length
          : 0;
        process.exit(count === 1 ? 0 : 1);
      ' "$response"; then
      return 0
    fi
    sleep 1
  done
  fail "eias-lab did not register within 60 seconds"
}
