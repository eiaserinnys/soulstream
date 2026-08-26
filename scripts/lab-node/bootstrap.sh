#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_command docker
require_command flock
require_command git
require_command node
require_command openssl
require_command pnpm

[[ "$LAB_REPO_ROOT" == "$LAB_DEFAULT_ROOT/repo" ]] \
  || fail "bootstrap must run from the dedicated clone at $LAB_DEFAULT_ROOT/repo"
[[ -n "${LAB_CLAUDE_AUTH_SOURCE:-}" ]] \
  || fail "set LAB_CLAUDE_AUTH_SOURCE to a readable Claude auth token file"
[[ -r "$LAB_CLAUDE_AUTH_SOURCE" ]] || fail "Claude auth source is not readable"

umask 077
mkdir -p "$LAB_ROOT"
if [[ ! -f "$LAB_ENV_FILE" ]]; then
  postgres_password="$(openssl rand -hex 32)"
  bearer_token="$(openssl rand -hex 32)"
  jwt_secret="$(openssl rand -hex 32)"
  {
    printf 'LAB_REPO=%q\n' "$LAB_ROOT/repo"
    printf 'LAB_ORCH_PORT=5300\n'
    printf 'LAB_NODE_PORT=3116\n'
    printf 'LAB_POSTGRES_PORT=5437\n'
    printf 'LAB_POSTGRES_CONTAINER=soulstream-lab-postgres\n'
    printf 'LAB_POSTGRES_VOLUME=soulstream-lab-postgres-data\n'
    printf 'LAB_POSTGRES_DB=soulstream_lab\n'
    printf 'LAB_POSTGRES_USER=soulstream_lab\n'
    printf 'LAB_POSTGRES_PASSWORD=%s\n' "$postgres_password"
    printf 'LAB_AUTH_BEARER_TOKEN=%s\n' "$bearer_token"
    printf 'LAB_JWT_SECRET=%s\n' "$jwt_secret"
    printf 'LAB_CLAUDE_AUTH_FILE=%q\n' "$LAB_ROOT/state/claude-auth.json"
  } >"$LAB_ENV_FILE"
  chmod 600 "$LAB_ENV_FILE"
fi

load_lab_env
ensure_main_fetch_refspec "$LAB_REPO"
mkdir -p \
  "$LAB_ROOT/state" \
  "$LAB_ROOT/logs" \
  "$LAB_ROOT/outbox" \
  "$LAB_ROOT/runner-state" \
  "$LAB_ROOT/workspace" \
  "$LAB_ROOT/state/config" \
  "$LAB_ROOT/state/incoming" \
  "$LAB_ROOT/state/cache" \
  "$LAB_ROOT/state/runner-releases" \
  "$LAB_ROOT/state/database-release"

if [[ ! -f "$LAB_CLAUDE_AUTH_FILE" ]]; then
  install -m 600 "$LAB_CLAUDE_AUTH_SOURCE" "$LAB_CLAUDE_AUTH_FILE"
fi

cat >"$LAB_ROOT/state/config/agents.yaml" <<EOF
agents:
  - id: lab-claude
    name: Lab Claude
    backend: claude
    workspace_dir: $LAB_ROOT/workspace
    default_preset: claude-sonnet
EOF

cat >"$LAB_ROOT/state/config/model-catalog.yaml" <<'EOF'
presets:
  - id: claude-sonnet
    label: Claude - Sonnet
    backend: claude
    model: sonnet
EOF

cat >"$LAB_REPO/.env.soul-server-ts" <<EOF
SOULSTREAM_NODE_ID=eias-lab
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:$LAB_ORCH_PORT/ws/node
AUTH_BEARER_TOKEN=$LAB_AUTH_BEARER_TOKEN
HOST=127.0.0.1
PORT=$LAB_NODE_PORT
ENVIRONMENT=production
LOG_LEVEL=info
DATABASE_URL=$(lab_database_url)
EVENT_OUTBOX_DIR=$LAB_ROOT/outbox
SOUL_RUNNER_PROCESS_ENABLED=true
SOUL_RUNNER_STATE_DIR=$LAB_ROOT/runner-state
SOUL_RUNNER_ARTIFACT_DIR=$LAB_REPO/soul-server-ts/dist/runner
SOUL_RUNNER_RELEASES_DIR=$LAB_ROOT/state/runner-releases
SOUL_RUNNER_LEASE_TIMEOUT_MS=1800000
SOUL_RUNNER_REAPER_INTERVAL_MS=15000
SOUL_RUNNER_TERMINAL_RETENTION_MS=86400000
AGENTS_CONFIG_PATH=$LAB_ROOT/state/config/agents.yaml
AGENT_PROFILE_CACHE_PATH=$LAB_ROOT/state/cache/agent-profiles.json
MODEL_CATALOG_PATH=$LAB_ROOT/state/config/model-catalog.yaml
INCOMING_FILE_DIR=$LAB_ROOT/state/incoming
CLAUDE_AUTH_TOKEN_PATH=$LAB_CLAUDE_AUTH_FILE
CLAUDE_SESSION_RUNTIME_V2_ENABLED=true
CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS=300000
CLAUDE_SESSION_RUNTIME_MAX_ENTRIES=2
CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS=1800000
ATOM_ENABLED=false
MCP_ENABLED=false
MCP_INTERNAL_PORT=$((LAB_NODE_PORT + 1))
MCP_STATELESS_TRANSPORT_ENABLED=false
MCP_REQUIRE_AUTH=false
EOF
chmod 600 "$LAB_REPO/.env.soul-server-ts"

if [[ "${SOULSTREAM_HEAVY_LOCK_HELD:-}" != "1" ]]; then
  available_mb="$(free -m | awk '/^Mem:/{print $7}')"
  if (( available_mb < 2000 )); then
    printf 'available memory is %sMB; waiting 60 seconds before one retry\n' "$available_mb"
    sleep 60
    available_mb="$(free -m | awk '/^Mem:/{print $7}')"
  fi
  (( available_mb >= 2000 )) || fail "available memory remains below 2000MB"

  exec 9>/tmp/soulstream-heavy-verify.lock
  flock -w 300 9 || fail "timed out waiting for the host verification lock"
fi
timeout 300s env NODE_ENV=development pnpm --dir "$LAB_REPO" install --frozen-lockfile
timeout 300s node "$LAB_REPO/soul-server-ts/scripts/build_with_release_env.mjs" \
  --env-file "$LAB_REPO/.env.soul-server-ts"
timeout 300s pnpm --dir "$LAB_REPO/orch-server-ts" run build

ensure_postgres
unset DATABASE_URL
export DATABASE_URL="$(lab_database_url)"
release_id="lab-$(git -C "$LAB_REPO" rev-parse --short=12 HEAD)"
export SOULSTREAM_RELEASE_ID="$release_id"
export HANIEL_BACKUP_DIR="$LAB_ROOT/state/database-release/$release_id"
export HANIEL_SERVICE_CWD="$LAB_REPO"
node "$LAB_REPO/packages/db-schema/scripts/migrate.mjs" initialize
node "$LAB_REPO/packages/db-schema/scripts/migrate.mjs" verify
unset DATABASE_URL

printf 'lab bootstrap complete at %s\n' "$LAB_ROOT"
