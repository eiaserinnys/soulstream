#!/usr/bin/env bash

usage() {
  printf 'Usage: install.sh [--backends claude,codex,antigravity] [--ref git-ref] [--tailscale [--tailscale-auth-key key] [--tailscale-user login]] [--help]\n'
}

parse_args() {
  BACKENDS=claude,codex
  REF=
  REF_SET=false
  TAILSCALE=false
  TAILSCALE_AUTH_KEY=
  TAILSCALE_USER=
  while (($#)); do
    case "$1" in
      --help) usage; exit 0 ;;
      --tailscale) TAILSCALE=true; shift ;;
      --backends|--ref|--tailscale-auth-key|--tailscale-user)
        if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then usage >&2; exit 2; fi
        case "$1" in
          --ref) REF=$2; REF_SET=true ;;
          --backends) BACKENDS=$2 ;;
          --tailscale-auth-key) TAILSCALE_AUTH_KEY=$2 ;;
          --tailscale-user) TAILSCALE_USER=${2,,} ;;
        esac
        shift 2 ;;
      *) usage >&2; exit 2 ;;
    esac
  done
  if [[ "$TAILSCALE" != true && ( -n "$TAILSCALE_AUTH_KEY" || -n "$TAILSCALE_USER" ) ]]; then usage >&2; exit 2; fi
  local item normalized= remaining=$BACKENDS
  while :; do
    item=${remaining%%,*}
    case "$item" in claude|codex|antigravity) ;; *) usage >&2; exit 2 ;; esac
    if [[ ",$normalized," != *",$item,"* ]]; then normalized=${normalized:+$normalized,}$item; fi
    [[ "$remaining" == *,* ]] || break
    remaining=${remaining#*,}
  done
  BACKENDS=$normalized
}

has_backend() { [[ ",$BACKENDS," == *",$1,"* ]]; }

read_env_value() {
  local file=$1 key=$2 value
  [[ -f "$file" ]] || return 0
  value=$(awk -v key="$key" 'index($0,key "=")==1 { value=substr($0,length(key)+2) } END { print value }' "$file")
  value=${value#\"}; value=${value%\"}
  printf '%s' "$value"
}

prepare_secrets() {
  local root=$1 db_url
  BEARER=$(read_env_value "$root/.env.orch" AUTH_BEARER_TOKEN)
  JWT=$(read_env_value "$root/.env.orch" JWT_SECRET)
  ADMIN_PASSWORD=$(read_env_value "$root/.env.orch" DASHBOARD_ADMIN_PASSWORD)
  db_url=$(read_env_value "$root/.env.orch" DATABASE_URL)
  DB_PASSWORD=${db_url#postgresql://soulstream:}; DB_PASSWORD=${DB_PASSWORD%%@*}
  [[ "$db_url" == postgresql://soulstream:*@* ]] || DB_PASSWORD=
  [[ -n "$BEARER" ]] || BEARER=$(openssl rand -hex 32)
  [[ -n "$JWT" ]] || JWT=$(openssl rand -hex 32)
  [[ -n "$DB_PASSWORD" ]] || DB_PASSWORD=$(openssl rand -hex 32)
  if [[ "${TAILSCALE:-false}" != true ]]; then
    if [[ -z "$ADMIN_PASSWORD" && -f "$root/.admin-password" ]]; then ADMIN_PASSWORD=$(cat "$root/.admin-password"); fi
    if [[ -z "$ADMIN_PASSWORD" ]]; then ADMIN_PASSWORD=$(openssl rand -hex 12); fi
  fi
}

# Remove keys owned by the installer, preserving every other line verbatim.
merge_env() {
  local target=$1 fresh=$2 managed=$3 temp
  temp=$(mktemp "${target}.XXXXXX")
  if [[ -f "$target" ]]; then
    awk -v keys="$managed" 'BEGIN { n=split(keys,a," "); for(i=1;i<=n;i++) owned[a[i]]=1 }
      { line=$0; sub(/=.*/,"",line); if (!(line in owned)) print }' "$target" > "$temp"
  fi
  cat "$fresh" >> "$temp"
  chmod 600 "$temp"
  mv "$temp" "$target"
}

render_config() {
  local home=$1 root=$2 db_password=${3-} fresh_orch fresh_worker first backend name preset
  prepare_secrets "$root"
  if [[ -n "$db_password" ]]; then DB_PASSWORD=$db_password; fi
  mkdir -p "$root/config" "$home/workspace/.projects" "$root/.local"
  fresh_orch=$(mktemp); fresh_worker=$(mktemp)
  first=${BACKENDS%%,*}
  cat > "$fresh_orch" <<ENV
ENVIRONMENT=production
HOST=127.0.0.1
PORT=5200
DEFAULT_EXECUTION_NODE_ID=local
DEFAULT_PAS_AGENT_ID=${first}-default
DATABASE_URL=postgresql://soulstream:${DB_PASSWORD}@127.0.0.1:5432/soulstream
DASHBOARD_DIR=${root}/unified-dashboard/dist
AUTH_BEARER_TOKEN=${BEARER}
JWT_SECRET=${JWT}
ATOM_ENABLED=false
ENV
  if [[ "${TAILSCALE:-false}" == true ]]; then
    cat >> "$fresh_orch" <<ENV
SOULSTREAM_PUBLIC_URL=https://${TAILSCALE_DNS}
CORS_ALLOWED_ORIGINS=https://${TAILSCALE_DNS},http://127.0.0.1:5200
TAILSCALE_AUTH_ENABLED=true
TAILSCALE_ALLOWED_LOGIN=${TAILSCALE_USER}
ENV
  else
    cat >> "$fresh_orch" <<ENV
SOULSTREAM_PUBLIC_URL=http://127.0.0.1:5200
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5200,http://localhost:5200
DASHBOARD_ADMIN_PASSWORD=${ADMIN_PASSWORD}
ENV
  fi
  if has_backend antigravity; then printf 'AGY_CLI_PATH=%s/.local/bin/agy\n' "$home" >> "$fresh_orch"; fi
  cat > "$fresh_worker" <<ENV
ENVIRONMENT=production
SOULSTREAM_NODE_ID=local
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:5200/ws/node
SOULSTREAM_BACKENDS=${BACKENDS}
AUTH_BEARER_TOKEN=${BEARER}
PORTABLE_LOCAL_MCP_AUTHORIZATION="Bearer ${BEARER}"
HOST=127.0.0.1
PORT=4205
MCP_INTERNAL_PORT=4206
MCP_ENABLED=true
MCP_PATH=/mcp
MCP_REQUIRE_AUTH=true
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
AGENTS_CONFIG_PATH=${root}/config/agents.yaml
EVENT_OUTBOX_DIR=${root}/.local/event-outbox
INCOMING_FILE_DIR=${root}/.local/incoming
SOUL_RUNNER_PROCESS_ENABLED=true
SOUL_RUNNER_STATE_DIR=${root}/.local/r
SOUL_RUNNER_ARTIFACT_DIR=${root}/soul-server-ts/dist/runner
SOUL_RUNNER_RELEASES_DIR=${root}/.local/runner-releases
WORKTREE_MCP_ENABLED=true
WORKTREE_PROJECTS_ROOT=${home}/workspace/.projects
SESSION_ISOLATION_MODE=off
CLAUDE_ACCOUNT_POOL_ENABLED=false
ATOM_ENABLED=false
ENV
  if has_backend claude; then printf 'CLAUDE_AUTH_TOKEN_PATH=%s/.claude/.credentials.json\n' "$home" >> "$fresh_worker"; fi
  if has_backend codex; then printf 'CODEX_ADAPTER_MODE=app-server\n' >> "$fresh_worker"; fi
  merge_env "$root/.env.orch" "$fresh_orch" 'ENVIRONMENT HOST PORT DEFAULT_EXECUTION_NODE_ID DEFAULT_PAS_AGENT_ID DATABASE_URL DASHBOARD_DIR SOULSTREAM_PUBLIC_URL CORS_ALLOWED_ORIGINS AUTH_BEARER_TOKEN JWT_SECRET DASHBOARD_ADMIN_PASSWORD TAILSCALE_AUTH_ENABLED TAILSCALE_ALLOWED_LOGIN ATOM_ENABLED AGY_CLI_PATH'
  merge_env "$root/.env.soul-server-ts" "$fresh_worker" 'ENVIRONMENT SOULSTREAM_NODE_ID SOULSTREAM_UPSTREAM_URL SOULSTREAM_BACKENDS AUTH_BEARER_TOKEN PORTABLE_LOCAL_MCP_AUTHORIZATION HOST PORT MCP_INTERNAL_PORT MCP_ENABLED MCP_PATH MCP_REQUIRE_AUTH MCP_ALLOWED_HOSTS AGENTS_CONFIG_PATH EVENT_OUTBOX_DIR INCOMING_FILE_DIR SOUL_RUNNER_PROCESS_ENABLED SOUL_RUNNER_STATE_DIR SOUL_RUNNER_ARTIFACT_DIR SOUL_RUNNER_RELEASES_DIR WORKTREE_MCP_ENABLED WORKTREE_PROJECTS_ROOT SESSION_ISOLATION_MODE CLAUDE_ACCOUNT_POOL_ENABLED ATOM_ENABLED CLAUDE_AUTH_TOKEN_PATH CODEX_ADAPTER_MODE CLAUDE_CODE_EXECPATH CODEX_CLI_PATH AGY_CLI_PATH DISABLE_AUTOUPDATER'
  rm -f "$fresh_orch" "$fresh_worker"
  if [[ "${TAILSCALE:-false}" != true ]]; then printf '%s\n' "$ADMIN_PASSWORD" > "$root/.admin-password"; chmod 600 "$root/.admin-password"; fi
  printf 'agents:\n' > "$root/config/agents.yaml"
  local IFS=,
  for backend in $BACKENDS; do
    case "$backend" in
      claude) name=Claude; preset=claude-opus ;;
      codex) name=Codex; preset=codex-6.2-sol ;;
      antigravity) name=Antigravity; preset=gemini-4-carbon ;;
    esac
    cat >> "$root/config/agents.yaml" <<YAML
  - id: ${backend}-default
    name: ${name}
    backend: ${backend}
    default_preset: ${preset}
    workspace_dir: ${home}/workspace
    mcp_profile: default
YAML
  done
  cat > "$root/config/mcp-registry.yaml" <<'YAML'
servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:4205/mcp
    headers:
      Authorization:
        env: PORTABLE_LOCAL_MCP_AUTHORIZATION
YAML
  cat > "$root/config/mcp-profiles.yaml" <<'YAML'
profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream]
YAML
  cat > "$home/workspace/AGENTS.md" <<'MARKDOWN'
# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under `.projects/<repository>--<branch>`.
The `soulstream` MCP server provides session and workspace tools.
Atom is disabled on this installation; do not call `search_skills` or `load_skill`.
MARKDOWN
  ln -sfn AGENTS.md "$home/workspace/CLAUDE.md"
}

# Parse status from stdin; status user IDs are numeric while User map keys are strings.
select_tailscale_identity() {
  local status login tagged
  status=$(cat)
  TAILSCALE_DNS=$(jq -r '.Self.DNSName // "" | rtrimstr(".")' <<< "$status")
  login=$(jq -r '.User[(.Self.UserID | tostring)].LoginName // ""' <<< "$status")
  tagged=$(jq -r '(.Self.Tags // []) | length > 0' <<< "$status")
  if [[ -z "$TAILSCALE_DNS" ]]; then printf 'Enable MagicDNS in your tailnet.\n' >&2; return 1; fi
  if [[ -z "${TAILSCALE_USER:-}" ]]; then
    if [[ "$tagged" == true || -z "$login" || "${login,,}" == tagged-devices ]]; then
      printf 'Tagged devices require --tailscale-user.\n' >&2; return 1
    fi
    TAILSCALE_USER=${login,,}
  fi
  TAILSCALE_USER=${TAILSCALE_USER#"${TAILSCALE_USER%%[![:space:]]*}"}
  TAILSCALE_USER=${TAILSCALE_USER%"${TAILSCALE_USER##*[![:space:]]}"}
  TAILSCALE_USER=${TAILSCALE_USER,,}
  if [[ -z "$TAILSCALE_USER" || "$TAILSCALE_USER" =~ [[:space:]] ]]; then printf 'Invalid Tailscale login.\n' >&2; return 1; fi
}

setup_tailscale() {
  if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh >> "$LOG" 2>&1; fi
  if ! tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null; then
    if [[ -n "$TAILSCALE_AUTH_KEY" ]]; then
      local key_file
      key_file=$(mktemp); chmod 600 "$key_file"
      printf '%s' "$TAILSCALE_AUTH_KEY" > "$key_file"
      if ! tailscale up --auth-key="file:$key_file" >> "$LOG" 2>&1; then rm -f "$key_file"; return 1; fi
      rm -f "$key_file"
      TAILSCALE_AUTH_KEY=
    else
      timeout 600 tailscale up >&3 2>&3
    fi
  fi
  select_tailscale_identity < <(tailscale status --json)
}

setup_tailscale_serve() {
  if ! tailscale serve --bg http://127.0.0.1:5200; then
    printf 'Enable HTTPS in the Tailscale admin console, then retry.\n' >&2
    return 1
  fi
}

preflight() {
  if ((EUID != 0)); then printf 'Run again with sudo.\n' >&2; exit 1; fi
  if ! ( source /etc/os-release; [[ "$ID" == debian && "$VERSION_ID" == 13 && "$(uname -m)" == x86_64 ]] ); then
    printf 'Debian 13 x86_64 is required.\n' >&2; exit 1
  fi
  if (( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) < 3670016 )) || (( $(df -Pk / | awk 'NR==2 {print $4}') < 19531250 )); then
    printf 'At least 3.5 GiB RAM and 20 GB free disk are required.\n' >&2; exit 1
  fi
}

install_packages() { export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y sudo tmux curl ca-certificates git jq openssl build-essential python3 postgresql-17; }
setup_account() {
  id soulstream >/dev/null 2>&1 || useradd -m -d /home/soulstream -s /bin/bash soulstream
  if [[ -f /root/.ssh/authorized_keys && ! -e /home/soulstream/.ssh/authorized_keys ]]; then
    install -d -m 700 -o soulstream -g soulstream /home/soulstream/.ssh
    install -m 600 -o soulstream -g soulstream /root/.ssh/authorized_keys /home/soulstream/.ssh/authorized_keys
  fi
}
install_node() {
  local version=v22.23.5 archive="node-v22.23.5-linux-x64.tar.gz" dir
  if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$version" ]]; then
    dir=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/$version/$archive" -o "$dir/$archive"
    curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"
    (cd "$dir" && grep "  $archive$" SHASUMS256.txt | sha256sum -c -)
    tar -xzf "$dir/$archive" -C /usr/local --strip-components=1
    rm -rf "$dir"
  fi
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  corepack enable
}
as_soul() { sudo -H -u soulstream env HOME=/home/soulstream PATH=/home/soulstream/.local/bin:/usr/local/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }
install_clis() {
  if has_backend claude; then
    if ! as_soul bash -c 'command -v claude >/dev/null'; then as_soul bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash'; fi
    as_soul claude --version
  fi
  if has_backend codex; then
    if ! as_soul bash -c 'command -v codex >/dev/null'; then npm install -g @openai/codex; fi
    as_soul codex --version
    as_soul mkdir -p /home/soulstream/.codex
    as_soul touch /home/soulstream/.codex/config.toml
    if ! grep -Eq '^[[:space:]]*cli_auth_credentials_store[[:space:]]*=' /home/soulstream/.codex/config.toml; then
      printf '\ncli_auth_credentials_store = "file"\n' >> /home/soulstream/.codex/config.toml
    fi
  fi
  if has_backend antigravity; then
    if ! as_soul bash -c 'command -v agy >/dev/null'; then as_soul bash -o pipefail -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'; fi
    as_soul agy --version
  fi
}
clone_repository() {
  local root=$1
  if [[ ! -d "$root/.git" ]]; then
    as_soul git clone https://github.com/eiaserinnys/soulstream.git "$root"
    as_soul git -C "$root" checkout "${REF:-main}"
  elif [[ "$REF_SET" == true ]]; then
    if [[ -n "$(as_soul git -C "$root" status --porcelain --untracked-files=no)" ]]; then printf 'Repository has uncommitted changes.\n' >&2; return 1; fi
    as_soul git -C "$root" fetch origin
    as_soul git -C "$root" checkout "$REF"
  fi
  as_soul git -C "$root" rev-parse HEAD
}
setup_database() {
  local root=$1
  prepare_secrets "$root"
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='soulstream'" | grep -qx 1; then
    printf "CREATE ROLE soulstream LOGIN PASSWORD '%s';\n" "$DB_PASSWORD" | sudo -u postgres psql -v ON_ERROR_STOP=1 >/dev/null
  fi
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='soulstream'" | grep -qx 1; then sudo -u postgres createdb -O soulstream soulstream; fi
}
write_configuration() {
  render_config /home/soulstream "$1" "$DB_PASSWORD"
  chown -R soulstream:soulstream "$1/config" "$1/.env.orch" "$1/.env.soul-server-ts" "$1/.local" /home/soulstream/workspace
  if [[ "$TAILSCALE" != true && -f "$1/.admin-password" ]]; then chown soulstream:soulstream "$1/.admin-password"; fi
}
build_project() {
  local root=$1
  as_soul bash -ec 'cd "$1"; corepack pnpm install --frozen-lockfile --prod=false; SOULSTREAM_RELEASE_ENV_FILE="$1/.env.soul-server-ts" corepack pnpm --filter @soulstream/soul-server-ts run build; corepack pnpm --filter @soulstream/orch-server-ts run build; corepack pnpm --dir "$1/unified-dashboard" run build' bash "$root"
}
setup_schema() {
  local root=$1 sha
  sha=$(as_soul git -C "$root" rev-parse --short=12 HEAD)
  as_soul bash -ec 'cd "$1"; export HANIEL_SERVICE_ENV_FILE="$1/.env.orch" SOULSTREAM_RELEASE_ID="clean-$2"; node packages/db-schema/scripts/migrate.mjs initialize; node packages/db-schema/scripts/migrate.mjs verify' bash "$root" "$sha"
  local owner=owner@local display_name=Owner
  if [[ "$TAILSCALE" == true ]]; then owner=$TAILSCALE_USER; display_name=$owner; fi
  sudo -u postgres psql -d soulstream -v ON_ERROR_STOP=1 -v "owner=$owner" -v "display_name=$display_name" >/dev/null <<'SQL'
INSERT INTO users (email, display_name, is_admin) VALUES (:'owner', :'display_name', TRUE) ON CONFLICT (email) DO NOTHING;
SQL
}
install_units() {
  local root=$1
  cat > /etc/systemd/system/soulstream-orch.service <<UNIT
[Unit]
Description=Soulstream orchestrator
After=network.target postgresql.service
[Service]
User=soulstream
WorkingDirectory=$root/orch-server-ts
EnvironmentFile=$root/.env.orch
Environment=HOME=/home/soulstream
Environment=PATH=/home/soulstream/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node dist/production_main.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/soulstream-worker.service <<UNIT
[Unit]
Description=Soulstream worker
After=network.target soulstream-orch.service
Wants=soulstream-orch.service
[Service]
User=soulstream
WorkingDirectory=$root
Environment=HOME=/home/soulstream
Environment=PATH=/home/soulstream/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node soul-server-ts/dist/main.js
KillMode=process
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable soulstream-orch.service soulstream-worker.service
  systemctl restart soulstream-orch.service soulstream-worker.service
}
wait_and_create_workspace() {
  local root=$1 header cookie deadline status count
  header=$(mktemp); cookie=$(mktemp); chmod 600 "$header" "$cookie"
  printf 'Authorization: Bearer %s\n' "$(read_env_value "$root/.env.orch" AUTH_BEARER_TOKEN)" > "$header"
  deadline=$((SECONDS+120))
  until curl --max-time 3 -fsS http://127.0.0.1:5200/api/health >/dev/null 2>&1 && curl --max-time 3 -fsS http://127.0.0.1:4205/health >/dev/null 2>&1 && curl --max-time 3 -fsS -H "@$header" http://127.0.0.1:5200/api/nodes 2>/dev/null | jq -e '.nodes[] | select(.nodeId=="local" and .connected==true)' >/dev/null; do
    if ((SECONDS >= deadline)); then journalctl -u soulstream-orch.service -n 50 --no-pager; journalctl -u soulstream-worker.service -n 50 --no-pager; rm -f "$header" "$cookie"; return 1; fi
    sleep 2
  done
  if [[ "$TAILSCALE" == true ]]; then
    printf 'Tailscale-User-Login: %s\n' "$TAILSCALE_USER" > "$cookie"
    count=$(curl -fsS -H "@$cookie" http://127.0.0.1:5200/api/folders | jq '[.folders[] | select(.name=="작업실")] | length')
    if [[ "$count" == 0 ]]; then
      curl -fsS -H "@$cookie" -X POST -H 'Content-Type: application/json' --data '{"name":"작업실","idempotencyKey":"clean-install-default-workspace"}' http://127.0.0.1:5200/api/folders >/dev/null
    fi
    curl -fsS -H "@$cookie" http://127.0.0.1:5200/api/folders | jq -e '[.folders[] | select(.name=="작업실")] | length == 1' >/dev/null
    status=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5200/api/folders)
    [[ "$status" == 401 ]]
    status=$(curl -s -o /dev/null -w '%{http_code}' -H "@$cookie" -H 'Tailscale-Funnel-Request: ?1' http://127.0.0.1:5200/api/folders)
    [[ "$status" == 401 ]]
    status=$(curl -s -o /dev/null -w '%{http_code}' -H "Tailscale-User-Login: ${TAILSCALE_USER}.other" http://127.0.0.1:5200/api/folders)
    [[ "$status" == 401 || "$status" == 403 ]]
    rm -f "$header" "$cookie"
    return 0
  fi
  printf '{"password":"%s"}' "$(cat "$root/.admin-password")" | curl -fsS -c "$cookie" -X POST -H 'Content-Type: application/json' --data @- http://127.0.0.1:5200/api/auth/password-login >/dev/null
  count=$(curl -fsS -b "$cookie" http://127.0.0.1:5200/api/folders | jq '[.folders[] | select(.name=="작업실")] | length')
  if [[ "$count" == 0 ]]; then
    curl -fsS -b "$cookie" -X POST -H 'Content-Type: application/json' --data '{"name":"작업실","idempotencyKey":"clean-install-default-workspace"}' http://127.0.0.1:5200/api/folders >/dev/null
  fi
  curl -fsS -b "$cookie" http://127.0.0.1:5200/api/folders | jq -e '[.folders[] | select(.name=="작업실")] | length == 1' >/dev/null
  status=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5200/api/folders)
  rm -f "$header" "$cookie"
  [[ "$status" == 401 ]]
}
refresh_model_presets() {
  local root=$1 header token response result attempt presets counts
  PRESET_REFRESH_PENDING=true
  if ! header=$(mktemp); then
    printf 'Model preset refresh: could not create authorization header.\n' || true
    return 0
  fi
  if ! chmod 600 "$header" || ! token=$(read_env_value "$root/.env.orch" AUTH_BEARER_TOKEN) ||
     ! printf 'Authorization: Bearer %s\n' "$token" > "$header"; then
    printf 'Model preset refresh: could not prepare authorization header.\n' || true
    rm -f "$header" || true
    return 0
  fi
  for ((attempt=1; attempt<=6; attempt++)); do
    result='pending|local unavailable'
    if response=$(curl --max-time 60 -fsS -X POST -H "@$header" http://127.0.0.1:5200/api/usage/refresh 2>/dev/null); then
      if result=$(jq -r '
        first(.nodes[]? | select(.nodeId == "local")) as $node |
        ["claude", "codex", "antigravity", "opencode_go"] as $names |
        ($node.providers // {}) as $providers |
        (if $node != null and $node.stale == false and
            all($names[]; . as $name | $providers[$name] != null and
              ($providers[$name].status == "auto" or $providers[$name].status == "not_configured") and
              $providers[$name].stale == false)
          then "confirmed" else "pending" end) + "|" +
        (if $node == null then "local unavailable" else
          [$names[] | . as $name | $providers[$name] as $p |
            "\($name):status=\(if $p.status == "auto" or $p.status == "not_configured" or $p.status == "error" then $p.status else "unknown" end),stale=\(if $p.stale == true then "true" elif $p.stale == false then "false" else "unknown" end)"] | join(" ")
          end)
      ' <<< "$response" 2>/dev/null); then :; else result='pending|local unavailable'; fi
    fi
    printf 'Preset refresh attempt %s: %s\n' "$attempt" "${result#*|}" || true
    if [[ "$result" == confirmed\|* ]]; then
      unset PRESET_REFRESH_PENDING
      if presets=$(curl --max-time 60 -fsS -H "@$header" http://127.0.0.1:5200/api/nodes/local/model-presets 2>/dev/null) &&
         counts=$(jq -er '[.model_presets[] | {backend, available, reason}] | group_by([.backend, .available, .reason]) | map("\(.[0].backend) available=\(.[0].available) reason=\(.[0].reason) count=\(length)") | join("; ")' <<< "$presets" 2>/dev/null); then
        printf 'Model presets: %s\n' "$counts" || true
      else
        printf 'Model preset counts unavailable; skipping.\n' || true
      fi
      break
    fi
    if ((attempt < 6)); then sleep 10 || true; fi
  done
  rm -f "$header" || true
  return 0
}
finish_message() {
  local root=$1
  printf '\nInstalled %s; backends: %s\n' "$(as_soul git -C "$root" rev-parse --short=12 HEAD)" "$BACKENDS"
  if [[ "$TAILSCALE" == true ]]; then
    printf 'Open https://%s from a tailnet device signed in as %s.\n' "$TAILSCALE_DNS" "$TAILSCALE_USER"
    printf 'Local processes on this server can forge identity headers.\n'
    printf 'Remove access: tailscale serve reset && tailscale logout\n'
  else
  printf 'Connect: ssh -L 127.0.0.1:5200:127.0.0.1:5200 <user>@<server>\nOpen http://127.0.0.1:5200\n'
  printf 'Administrator password: %s\nStored in: %s/.admin-password\n' "$(cat "$root/.admin-password")" "$root"
  fi
  if has_backend claude; then printf 'Claude: sudo -Hu soulstream env BROWSER=/bin/false /home/soulstream/.local/bin/claude auth login (open the URL on another device).\n'; fi
  if has_backend codex; then printf 'Codex: sudo -Hu soulstream /usr/local/bin/codex login --device-auth (enable device code login in ChatGPT security settings).\n'; fi
  if has_backend antigravity; then printf 'Antigravity: ssh soulstream@<server>, run ~/.local/bin/agy, sign in, then /exit.\n'; fi
  printf 'After login, presets update within five minutes. To refresh now as root:\n'
  printf '%s\n' "awk -F= '/^AUTH_BEARER_TOKEN=/{print \"Authorization: Bearer \" substr(\$0,index(\$0,\"=\")+1)}' $root/.env.orch | curl -fsS -X POST -H @- http://127.0.0.1:5200/api/usage/refresh"
  if [[ "${PRESET_REFRESH_PENDING:-false}" == true ]]; then printf 'Model preset status is not confirmed yet; it updates within five minutes.\n'; fi
}
on_error() { trap - ERR; printf '\nInstallation failed at: %s\nLog: %s\n' "$STEP" "$LOG" >&3; tail -n 30 "$LOG" >&3; exit 1; }
run_step() { STEP=$1; shift; printf '%s\n' "$STEP"; "$@" >> "$LOG" 2>&1; }
prepare_install_cwd() { cd /; }
main() {
  set -Eeuo pipefail
  parse_args "$@"
  prepare_install_cwd
  preflight
  local root=/home/soulstream/soulstream
  exec 3>&2
  LOG=/var/log/soulstream-install.log; STEP=setup
  touch "$LOG"; chmod 600 "$LOG"; trap on_error ERR
  run_step 'Installing packages' install_packages
  if [[ "$TAILSCALE" == true ]]; then STEP='Setting up Tailscale'; printf '%s\n' "$STEP"; setup_tailscale; fi
  run_step 'Setting up account' setup_account
  run_step 'Installing Node.js' install_node
  run_step 'Installing selected CLIs' install_clis
  run_step 'Cloning repository' clone_repository "$root"
  run_step 'Preparing database' setup_database "$root"
  run_step 'Writing configuration' write_configuration "$root"
  run_step 'Building Soulstream' build_project "$root"
  run_step 'Initializing schema' setup_schema "$root"
  run_step 'Starting services' install_units "$root"
  if [[ "$TAILSCALE" == true ]]; then run_step 'Enabling Tailscale Serve' setup_tailscale_serve; fi
  run_step 'Checking services and workspace' wait_and_create_workspace "$root"
  run_step 'Checking model presets' refresh_model_presets "$root"
  finish_message "$root"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
