#!/usr/bin/env bash
set -euo pipefail

LAB_DEFAULT_ROOT=/home/eias/services/soulstream-lab
LAB_SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
LAB_REPO_ROOT="$(git -C "$LAB_SCRIPT_DIR/../.." rev-parse --show-toplevel)"
LAB_ROOT="${SOULSTREAM_LAB_ROOT:-$LAB_DEFAULT_ROOT}"
LAB_ENV_FILE="$LAB_ROOT/.env"
LAB_INTERVENTION_ACCEPTANCE_SECONDS=60
LAB_HARNESS_PROCESS_CEILING_SECONDS=180

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
  return 0
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

pid_is_owned_runner() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local command
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command" == *"$LAB_ROOT/state/runner-releases/"*"/runner_entry.js"* ]]
  [[ "$command" == *"--config $LAB_ROOT/runner-state/"*"/runner-config.json"* ]]
}

owned_runner_pids() {
  local process pid
  for process in /proc/[0-9]*; do
    pid="${process##*/}"
    pid_is_owned_runner "$pid" && printf '%s\n' "$pid"
  done
}

process_group_counts() {
  local pgid="$1"
  local candidate state live=0 zombie=0
  while read -r candidate state; do
    [[ "$candidate" == "$pgid" ]] || continue
    state="${state//[[:space:]]/}"
    [[ -n "$state" ]] || continue
    if [[ "$state" == Z* ]]; then
      zombie=$((zombie + 1))
    else
      live=$((live + 1))
    fi
  done < <(ps -e -o pgid=,stat= 2>/dev/null || true)
  printf '%s %s\n' "$live" "$zombie"
}

wait_for_empty_process_group() {
  local name="$1"
  local pgid="$2"
  local attempts="$3"
  local attempt live zombie
  for attempt in $(seq 1 "$attempts"); do
    read -r live zombie < <(process_group_counts "$pgid")
    if (( live == 0 && zombie == 0 )); then
      printf '%s stopped with live=0 zombie=0\n' "$name"
      return 0
    fi
    sleep 0.1
  done
  read -r live zombie < <(process_group_counts "$pgid")
  fail "infra contamination: $name process group $pgid remains live=$live zombie=$zombie"
}

stop_owned_process_group() {
  local name="$1"
  local pid="$2"
  local entrypoint="$3"
  pid_matches_entrypoint "$pid" "$entrypoint" \
    || fail "$name pid points to a foreign process; refusing SIGTERM"

  local pgid
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 ]] \
    || fail "$name has an unsafe process group: $pgid"
  [[ "$pgid" == "$pid" ]] \
    || fail "$name is not its process-group leader; refusing group signal"

  kill -TERM -- "-$pgid"
  wait_for_empty_process_group "$name" "$pgid" 300
}

stop_owned_runners() {
  local runners=()
  mapfile -t runners < <(owned_runner_pids)
  local stopped_count="${#runners[@]}"
  local pid
  for pid in "${runners[@]}"; do
    pid_is_owned_runner "$pid" \
      || fail "runner $pid changed identity before stop"
    stop_owned_process_group \
      "lab-runner-$pid" "$pid" "$LAB_ROOT/state/runner-releases/"
  done
  mapfile -t runners < <(owned_runner_pids)
  (( ${#runners[@]} == 0 )) \
    || fail "lab runners remain after stop: ${runners[*]}"
  printf 'lab runners stopped: %s; live=0 zombie=0\n' "$stopped_count"
}

gc_orphan_runner_releases() {
  local releases_root="$LAB_ROOT/state/runner-releases"
  [[ "$releases_root" == "$LAB_ROOT/state/runner-releases" ]] \
    || fail "unsafe runner release root"
  [[ -d "$releases_root" ]] || return 0
  [[ -d "$LAB_ROOT/runner-state" ]] || fail "missing lab runner state root"

  local references
  references="$(node - "$LAB_ROOT/runner-state" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
for (const name of fs.readdirSync(root)) {
  const configPath = path.join(root, name, "runner-config.json");
  if (!fs.existsSync(configPath)) continue;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (typeof config.codeSha !== "string" || !config.codeSha.startsWith("sha256-")) {
    throw new Error(`invalid runner codeSha in ${configPath}`);
  }
  process.stdout.write(`${config.codeSha}\n`);
}
NODE
)" || fail "could not enumerate referenced runner releases"

  local release name removed=0
  while IFS= read -r -d '' release; do
    [[ "$release" == "$releases_root"/sha256-* ]] \
      || fail "unsafe runner release candidate: $release"
    name="${release##*/}"
    if grep -Fxq "$name" <<<"$references"; then
      continue
    fi
    rm -rf -- "$release"
    removed=$((removed + 1))
  done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -name 'sha256-*' -print0)
  printf 'orphan runner releases removed: %s\n' "$removed"
}

run_with_process_group_ceiling() {
  local ceiling_seconds="$1"
  local command_identity="$2"
  shift 2
  [[ "$ceiling_seconds" =~ ^[1-9][0-9]*$ ]] || fail "invalid process ceiling"
  [[ -n "$command_identity" ]] || fail "command identity is required"
  [[ -d "$LAB_ROOT/state" ]] || fail "missing lab state root"

  local group_file
  group_file="$(mktemp "$LAB_ROOT/state/.harness-process-group.XXXXXX")"

  local status
  set +e
  timeout --signal=TERM --kill-after=5s "${ceiling_seconds}s" \
    bash -c 'printf "%s\n" "$PPID" > "$1"; shift; exec "$@"' \
    lab-process-group "$group_file" "$@"
  status=$?
  set -e

  [[ -s "$group_file" ]] || fail "$command_identity did not publish its process group"
  local pgid
  pgid="$(<"$group_file")"
  rm -f "$group_file"
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 ]] \
    || fail "$command_identity published an unsafe process group: $pgid"
  wait_for_empty_process_group "$command_identity" "$pgid" 50
  return "$status"
}

ensure_main_fetch_refspec() {
  local repo="$1"
  [[ -d "$repo/.git" ]] || fail "not a Git clone: $repo"
  git -C "$repo" config --replace-all remote.origin.fetch \
    '+refs/heads/*:refs/remotes/origin/*'
  git -C "$repo" fetch --prune origin
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

  require_command setsid
  mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")"
  local temporary_pid_file="$pid_file.tmp"
  rm -f "$temporary_pid_file"
  setsid -f bash -c '
    runtime_dir="$1"
    pid_path="$2"
    shift 2
    cd "$runtime_dir"
    printf "%s\n" "$$" >"$pid_path"
    for fd_path in /proc/$$/fd/*; do
      fd="${fd_path##*/}"
      if [[ "$fd" =~ ^[0-9]+$ ]] && (( fd > 2 )); then
        eval "exec ${fd}>&-"
      fi
    done
    exec "$@"
  ' lab-detach "$LAB_REPO" "$temporary_pid_file" "$@" \
    </dev/null >>"$log_file" 2>&1
  local attempt
  for attempt in $(seq 1 50); do
    [[ -s "$temporary_pid_file" ]] && break
    sleep 0.1
  done
  [[ -s "$temporary_pid_file" ]] || fail "$name did not publish its detached pid"
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
  stop_owned_process_group "$name" "$pid" "$entrypoint"
  rm -f "$pid_file"
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
