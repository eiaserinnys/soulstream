#!/usr/bin/env bash

# Atom listens on loopback; tests point this at a fake server.
ATOM_URL=http://127.0.0.1:4200
ATOM_API_KEY_RE='^[A-Za-z0-9._~+/=-]+$'
ATOM_SEED_WARNINGS=
# Exported seed names that configuration reads from config/.atom-seed-map.json.
ATOM_SEED_NAMES='skill_catalog domain_catalog common_rules common_rules_extra codex_rules claude_common_rules coding_common_rules coding_common_rules_extra seosoyoung_rules seosoyoung_general seosoyoung_skills seosoyoung_rules_pas seosoyoung_skills_pas seosoyoung_rules_extra_pas card_orchestrator_root'

usage() {
  printf 'Usage: install.sh [--backends claude,codex,antigravity] [--ref git-ref] [--atom-ref git-ref] [--tailscale [--tailscale-auth-key-file path] [--tailscale-user login]] [--help]\n'
}

parse_args() {
  BACKENDS=claude,codex
  REF=
  REF_SET=false
  ATOM_REF=
  ATOM_REF_SET=false
  TAILSCALE=false
  TAILSCALE_AUTH_KEY=
  TAILSCALE_AUTH_KEY_FILE=
  TAILSCALE_USER=
  while (($#)); do
    case "$1" in
      --help) usage; exit 0 ;;
      --tailscale) TAILSCALE=true; shift ;;
      --backends|--ref|--atom-ref|--tailscale-auth-key|--tailscale-auth-key-file|--tailscale-user)
        if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then usage >&2; exit 2; fi
        case "$1" in
          --ref) REF=$2; REF_SET=true ;;
          --atom-ref) ATOM_REF=$2; ATOM_REF_SET=true ;;
          --backends) BACKENDS=$2 ;;
          --tailscale-auth-key) TAILSCALE_AUTH_KEY=$2 ;;
          --tailscale-auth-key-file) TAILSCALE_AUTH_KEY_FILE=$2 ;;
          --tailscale-user) TAILSCALE_USER=${2,,} ;;
        esac
        shift 2 ;;
      *) usage >&2; exit 2 ;;
    esac
  done
  if [[ "$TAILSCALE" != true && ( -n "$TAILSCALE_AUTH_KEY" || -n "$TAILSCALE_AUTH_KEY_FILE" || -n "$TAILSCALE_USER" ) ]]; then usage >&2; exit 2; fi
  if [[ -n "$TAILSCALE_AUTH_KEY" && -n "$TAILSCALE_AUTH_KEY_FILE" ]]; then usage >&2; exit 2; fi
  if [[ -n "$TAILSCALE_AUTH_KEY_FILE" ]]; then
    if [[ ! -f "$TAILSCALE_AUTH_KEY_FILE" || ! -r "$TAILSCALE_AUTH_KEY_FILE" ]]; then printf 'Tailscale auth key file is not readable.\n' >&2; exit 2; fi
    # The installer changes to / before Tailscale starts, so keep the path absolute.
    [[ "$TAILSCALE_AUTH_KEY_FILE" == /* ]] || TAILSCALE_AUTH_KEY_FILE=$PWD/$TAILSCALE_AUTH_KEY_FILE
  fi
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
  local root=$1 atom_root=$2 db_url
  BEARER=$(read_env_value "$root/.env.orch" AUTH_BEARER_TOKEN)
  JWT=$(read_env_value "$root/.env.orch" JWT_SECRET)
  ADMIN_PASSWORD=$(read_env_value "$root/.env.orch" DASHBOARD_ADMIN_PASSWORD)
  db_url=$(read_env_value "$root/.env.orch" DATABASE_URL)
  DB_PASSWORD=${db_url#postgresql://soulstream:}; DB_PASSWORD=${DB_PASSWORD%%@*}
  [[ "$db_url" == postgresql://soulstream:*@* ]] || DB_PASSWORD=
  [[ -n "$BEARER" ]] || BEARER=$(openssl rand -hex 32)
  [[ -n "$JWT" ]] || JWT=$(openssl rand -hex 32)
  [[ -n "$DB_PASSWORD" ]] || DB_PASSWORD=$(openssl rand -hex 32)
  # The administrator password signs in to both Soulstream and atom in every mode.
  if [[ -z "$ADMIN_PASSWORD" && -f "$root/.admin-password" ]]; then ADMIN_PASSWORD=$(<"$root/.admin-password"); fi
  if [[ -z "$ADMIN_PASSWORD" ]]; then ADMIN_PASSWORD=$(read_env_value "$atom_root/.env" DASHBOARD_ADMIN_PASSWORD); fi
  if [[ -z "$ADMIN_PASSWORD" ]]; then ADMIN_PASSWORD=$(openssl rand -hex 12); fi
  ATOM_JWT_SECRET=$(read_env_value "$atom_root/.env" JWT_SECRET)
  [[ -n "$ATOM_JWT_SECRET" ]] || ATOM_JWT_SECRET=$(openssl rand -hex 32)
}

# The only writer of <root>/.admin-password.
setup_secrets() {
  local root=$1 atom_root=$2 temp
  prepare_secrets "$root" "$atom_root"
  temp=$(mktemp "$root/.admin-password.XXXXXX")
  printf '%s\n' "$ADMIN_PASSWORD" > "$temp"
  chmod 600 "$temp"
  chown soulstream:soulstream "$temp"
  mv "$temp" "$root/.admin-password"
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

# Fill ATOM_NODES (declared by the caller) with UUID values from the seed map.
# null, missing and non-UUID values are absent; non-UUID values add a warning.
read_atom_seed_map() {
  local map=$1 line name value
  if ! jq -e 'type == "object"' "$map" >/dev/null 2>&1; then printf 'Atom seed map is missing or invalid: %s\n' "$map" >&2; return 1; fi
  while IFS= read -r line; do
    name=${line%%=*}; value=${line#*=}
    if [[ "$value" == '!' ]]; then
      ATOM_SEED_WARNINGS+="atom seed map: ignored invalid value for ${name}"$'\n'
    elif [[ -n "$value" ]]; then
      ATOM_NODES[$name]=$value
    fi
  done < <(jq -r --arg names "$ATOM_SEED_NAMES" '. as $map | $names | split(" ")[] | . as $name |
    "\($name)=\($map[$name] | if . == null then "" elif type == "string" and test("\\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\z") then . else "!" end)"' "$map")
}

read_atom_api_key() {
  local file=$1 key
  if [[ ! -s "$file" ]]; then printf 'Atom API key file is missing: %s\n' "$file" >&2; return 1; fi
  key=$(<"$file")
  if [[ ! "$key" =~ $ATOM_API_KEY_RE ]]; then printf 'Atom API key has an unexpected format.\n' >&2; return 1; fi
  printf '%s' "$key"
}

backend_preset() {
  case "$1" in
    claude) printf 'claude-opus' ;;
    codex) printf 'codex-6.2-sol' ;;
    antigravity) printf 'gemini-4-carbon' ;;
  esac
}

# Backend rules attached to profiles that run on the given backend.
backend_rules_context() {
  case "$1" in
    claude) printf 'claude_common_rules:5' ;;
    codex) printf 'codex_rules:5' ;;
  esac
}

# Print atom_contexts for name:depth or name:index items; absent names are skipped.
atom_contexts_yaml() {
  local item name depth node out=
  for item in "$@"; do
    name=${item%%:*}; depth=${item#*:}
    node=${ATOM_NODES[$name]:-}
    [[ -n "$node" ]] || continue
    if [[ "$depth" == index ]]; then
      out+="      - node_id: ${node}"$'\n'"        depth: 1"$'\n'"        titles_only: false"$'\n'"        mode: index"$'\n'
    else
      out+="      - node_id: ${node}"$'\n'"        depth: ${depth}"$'\n'"        titles_only: false"$'\n'"        include_ids: false"$'\n'
    fi
  done
  [[ -z "$out" ]] || printf '    atom_contexts:\n%s' "$out"
}

pas_disallowed_tools_yaml() {
  cat <<'YAML'
      - Agent
      - AskUserQuestion
      - Bash
      - Edit
      - Write
      - NotebookEdit
      - Glob
      - Grep
      - ListAgents
      - ReportFindings
      - ScheduleWakeup
      - Skill
      - Workflow
      - CronCreate
      - CronDelete
      - CronList
      - DesignSync
      - EnterPlanMode
      - ExitPlanMode
      - EnterWorktree
      - ExitWorktree
      - ListMcpResourcesTool
      - ReadMcpResourceTool
      - ReadMcpResourceDirTool
      - Monitor
      - PushNotification
      - RemoteTrigger
      - SendMessage
      - TaskStop
      - mcp__soulstream__add_card_comment
      - mcp__soulstream__add_card_report
      - mcp__soulstream__ask_card_question
      - mcp__soulstream__request_card_review
      - mcp__soulstream__update_card_brief
      - mcp__soulstream__start_card_work
      - mcp__soulstream__transfer_card_assignee
      - mcp__soulstream__update_card_orchestration_settings
      - mcp__soulstream__add_card_item
      - mcp__soulstream__add_card_note
      - mcp__soulstream__report_card_item
      - mcp__soulstream__set_card_items
      - mcp__soulstream__update_card_now
      - mcp__soulstream__delete_session
      - mcp__soulstream__move_sessions_to_folder
      - mcp__soulstream__set_session_name
      - mcp__soulstream__set_session_persistent
      - mcp__soulstream__download_session_history
      - mcp__soulstream__create_folder
      - mcp__soulstream__delete_folder
      - mcp__soulstream__move_folder
      - mcp__soulstream__rename_folder
      - mcp__soulstream__archive_folder
      - mcp__soulstream__unarchive_folder
      - mcp__soulstream__set_folder_status
      - mcp__soulstream__set_folder_system_prompt
      - mcp__soulstream__create_markdown_document
      - mcp__soulstream__update_markdown_document
      - mcp__soulstream__delete_markdown_document
      - mcp__soulstream__create_page
      - mcp__soulstream__upsert_page_markdown
      - mcp__soulstream__batch_page_operations
      - mcp__soulstream__get_daily_page
      - mcp__soulstream__move_board_item_to_folder
      - mcp__soulstream__update_board_item_position
      - mcp__soulstream__create_custom_view
      - mcp__soulstream__patch_custom_view
      - mcp__soulstream__get_custom_view
      - mcp__soulstream__list_custom_views
      - mcp__soulstream__create_worktree
      - mcp__soulstream__remove_worktree
      - mcp__soulstream__delete_worktree_branch
      - mcp__soulstream__list_worktrees
      - mcp__soulstream__plan_agent_profile_update
      - mcp__soulstream__update_agent_profile
      - mcp__soulstream__plan_remote_agent_profile_update
      - mcp__soulstream__apply_remote_agent_profile_update
      - mcp__soulstream__plan_agent_mcp_profile_update
      - mcp__soulstream__set_agent_mcp_profile
      - mcp__soulstream__set_agent_atom_contexts
      - mcp__soulstream__register_existing_mcp_agent
      - mcp__soulstream__rollback_agents_config
      - mcp__soulstream__rollback_remote_agents_config
      - mcp__soulstream__list_agents_config_snapshots
      - mcp__soulstream__list_remote_agents_config_snapshots
      - mcp__soulstream__list_mcp_profiles
      - mcp__soulstream__list_mcp_registry
      - mcp__soulstream__create_recurring_job
      - mcp__soulstream__update_recurring_job
      - mcp__soulstream__archive_recurring_job
      - mcp__soulstream__reflect_brief
      - mcp__soulstream__reflect_cluster_brief
      - mcp__soulstream__reflect_service
      - mcp__soulstream__reflect_refresh
      - mcp__soulstream__background_claude_tasks
      - mcp__soulstream__list_claude_background_tasks
      - mcp__soulstream__get_claude_background_task_output
      - mcp__soulstream__stop_claude_background_task
      - mcp__atom__batch_op
      - mcp__atom__create_card
      - mcp__atom__create_symlink
      - mcp__atom__delete_card
      - mcp__atom__delete_node
      - mcp__atom__move_node
      - mcp__atom__update_card
      - mcp__atom__update_node
YAML
}

render_agents() {
  local home=$1 root=$2 first=${BACKENDS%%,*} backend name rules
  rules=$(backend_rules_context "$first")
  printf 'agents:\n'
  cat <<YAML
  - id: seosoyoung
    name: 서소영
    backend: ${first}
    default_preset: $(backend_preset "$first")
    workspace_dir: ${home}/workspace
    disallowed_tools:
      - Workflow
      - ScheduleWakeup
      - AskUserQuestion
      - Skill
      - ReportFindings
      - ListAgents
    claude_auto_memory_enabled: false
    mcp_profile: default
    portrait_path: ${root}/install/assets/portraits/seosoyoung.png
YAML
  atom_contexts_yaml common_rules:5 common_rules_extra:index $rules seosoyoung_rules:5 seosoyoung_skills:1
  cat <<YAML
  - id: seosoyoung-pas
    name: 서소영 (PAS)
    backend: ${first}
    default_preset: $(backend_preset "$first")
    workspace_dir: ${home}/workspace
    disallowed_tools:
YAML
  pas_disallowed_tools_yaml
  cat <<YAML
    context_scope: minimal
    claude_auto_memory_enabled: false
    mcp_profile: pas
    portrait_path: ${root}/install/assets/portraits/seosoyoung-pas.png
YAML
  atom_contexts_yaml common_rules:5 $rules seosoyoung_general:0 seosoyoung_rules_pas:5 seosoyoung_rules_extra_pas:index seosoyoung_skills_pas:1
  if has_backend claude; then
    cat <<YAML
  - id: card-orchestrator
    name: 카드 오케스트레이터
    backend: claude
    default_preset: claude-sonnet
    workspace_dir: ${home}/workspace
    context_scope: minimal
YAML
    atom_contexts_yaml card_orchestrator_root:5
  fi
  for backend in ${BACKENDS//,/ }; do
    case "$backend" in
      claude) name=Claude ;;
      codex) name=Codex ;;
      antigravity) name=Antigravity ;;
    esac
    cat <<YAML
  - id: ${backend}-default
    name: ${name}
    backend: ${backend}
    default_preset: $(backend_preset "$backend")
    workspace_dir: ${home}/workspace
    mcp_profile: default
YAML
    atom_contexts_yaml common_rules:5 common_rules_extra:index coding_common_rules:5 coding_common_rules_extra:0 $(backend_rules_context "$backend")
  done
}

# Uses the secrets chosen by setup_secrets and the database password from it.
render_config() {
  local home=$1 root=$2 fresh_orch fresh_worker atom_api_key
  local -A ATOM_NODES=()
  read_atom_seed_map "$root/config/.atom-seed-map.json" || return 1
  atom_api_key=$(read_atom_api_key "$root/.atom-api-key") || return 1
  mkdir -p "$root/config" "$home/workspace/.projects" "$root/.local"
  fresh_orch=$(mktemp); fresh_worker=$(mktemp)
  cat > "$fresh_orch" <<ENV
ENVIRONMENT=production
HOST=127.0.0.1
PORT=5200
DEFAULT_EXECUTION_NODE_ID=local
DEFAULT_PAS_AGENT_ID=seosoyoung-pas
DATABASE_URL=postgresql://soulstream:${DB_PASSWORD}@127.0.0.1:5432/soulstream
DASHBOARD_DIR=${root}/unified-dashboard/dist
AUTH_BEARER_TOKEN=${BEARER}
JWT_SECRET=${JWT}
ATOM_ENABLED=true
ATOM_SERVER_URL=http://127.0.0.1:4200
ATOM_API_KEY=${atom_api_key}
SKILL_CATALOG_NODE_ID=${ATOM_NODES[skill_catalog]:-}
DOMAIN_CATALOG_NODE_ID=${ATOM_NODES[domain_catalog]:-}
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
ATOM_ENABLED=true
ATOM_SERVER_URL=http://127.0.0.1:4200
ATOM_API_KEY=${atom_api_key}
ENV
  if has_backend claude; then printf 'CLAUDE_AUTH_TOKEN_PATH=%s/.claude/.credentials.json\n' "$home" >> "$fresh_worker"; fi
  if has_backend codex; then printf 'CODEX_ADAPTER_MODE=app-server\n' >> "$fresh_worker"; fi
  merge_env "$root/.env.orch" "$fresh_orch" 'ENVIRONMENT HOST PORT DEFAULT_EXECUTION_NODE_ID DEFAULT_PAS_AGENT_ID DATABASE_URL DASHBOARD_DIR SOULSTREAM_PUBLIC_URL CORS_ALLOWED_ORIGINS AUTH_BEARER_TOKEN JWT_SECRET DASHBOARD_ADMIN_PASSWORD TAILSCALE_AUTH_ENABLED TAILSCALE_ALLOWED_LOGIN ATOM_ENABLED ATOM_SERVER_URL ATOM_API_KEY SKILL_CATALOG_NODE_ID DOMAIN_CATALOG_NODE_ID AGY_CLI_PATH'
  merge_env "$root/.env.soul-server-ts" "$fresh_worker" 'ENVIRONMENT SOULSTREAM_NODE_ID SOULSTREAM_UPSTREAM_URL SOULSTREAM_BACKENDS AUTH_BEARER_TOKEN PORTABLE_LOCAL_MCP_AUTHORIZATION HOST PORT MCP_INTERNAL_PORT MCP_ENABLED MCP_PATH MCP_REQUIRE_AUTH MCP_ALLOWED_HOSTS AGENTS_CONFIG_PATH EVENT_OUTBOX_DIR INCOMING_FILE_DIR SOUL_RUNNER_PROCESS_ENABLED SOUL_RUNNER_STATE_DIR SOUL_RUNNER_ARTIFACT_DIR SOUL_RUNNER_RELEASES_DIR WORKTREE_MCP_ENABLED WORKTREE_PROJECTS_ROOT SESSION_ISOLATION_MODE CLAUDE_ACCOUNT_POOL_ENABLED ATOM_ENABLED ATOM_SERVER_URL ATOM_API_KEY CLAUDE_AUTH_TOKEN_PATH CODEX_ADAPTER_MODE CLAUDE_CODE_EXECPATH CODEX_CLI_PATH AGY_CLI_PATH DISABLE_AUTOUPDATER'
  rm -f "$fresh_orch" "$fresh_worker"
  render_agents "$home" "$root" > "$root/config/agents.yaml"
  cat > "$root/config/mcp-registry.yaml" <<'YAML'
servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:4205/mcp
    headers:
      Authorization:
        env: PORTABLE_LOCAL_MCP_AUTHORIZATION
  - id: atom
    type: streamable_http
    url: http://127.0.0.1:4200/mcp
    headers:
      x-api-key:
        env: ATOM_API_KEY
YAML
  cat > "$root/config/mcp-profiles.yaml" <<'YAML'
profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream, atom]
  - id: pas
    name: PAS
    mcp_servers: [soulstream, atom]
YAML
  cat > "$home/workspace/AGENTS.md" <<'MARKDOWN'
# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under `.projects/<repository>--<branch>`.
The `soulstream` MCP server provides session and workspace tools.
The `atom` MCP server holds your instructions and skills. Rules live under `에이전트 > 공통 > rules` and skills under `에이전트 > 공통 > skills`.
Find skills with `search_skills` and read them with `load_skill`. Read any other atom node with `compile_subtree`.
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
    if [[ -n "${TAILSCALE_AUTH_KEY_FILE:-}" ]]; then
      # Only the path is passed; the key never enters a shell variable or argv.
      tailscale up --auth-key="file:$TAILSCALE_AUTH_KEY_FILE" >> "$LOG" 2>&1
    elif [[ -n "$TAILSCALE_AUTH_KEY" ]]; then
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
  if ! tailscale serve --bg http://127.0.0.1:5200 || ! tailscale serve --bg --https=8443 http://127.0.0.1:4200; then
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
  local root=$1 url=$2 ref=$3 ref_set=$4
  if [[ ! -d "$root/.git" ]]; then
    as_soul git clone "$url" "$root"
    as_soul git -C "$root" checkout "${ref:-main}"
  elif [[ "$ref_set" == true ]]; then
    if [[ -n "$(as_soul git -C "$root" status --porcelain --untracked-files=no)" ]]; then printf '%s: Repository has uncommitted changes.\n' "$root" >&2; return 1; fi
    as_soul git -C "$root" fetch origin
    as_soul git -C "$root" checkout "$ref"
  fi
  as_soul git -C "$root" rev-parse HEAD
}
clone_repositories() {
  local root=$1 atom_root=$2
  clone_repository "$root" https://github.com/eiaserinnys/soulstream.git "$REF" "$REF_SET"
  # A first-stage installation without atom support; stop before anything else changes.
  if [[ ! -f "$root/install/seed/load_atom_seed.mjs" ]]; then
    printf 'This Soulstream checkout predates atom support. Updating an existing installation is not supported yet.\n' >&2
    return 1
  fi
  clone_repository "$atom_root" https://github.com/eiaserinnys/atom.git "$ATOM_REF" "$ATOM_REF_SET"
}
# Uses DB_PASSWORD from setup_secrets. The role SQL goes through stdin and psql output is discarded.
setup_database() {
  local name
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='soulstream'" | grep -qx 1; then
    if ! printf "CREATE ROLE soulstream LOGIN PASSWORD '%s';\n" "$DB_PASSWORD" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 >/dev/null 2>/dev/null; then printf 'Failed to create PostgreSQL role soulstream.\n' >>"$LOG"; return 1; fi
  fi
  for name in soulstream atom; do
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${name}'" | grep -qx 1; then sudo -u postgres createdb -O soulstream "$name"; fi
  done
}
build_atom() {
  local atom_root=$1
  as_soul env NODE_ENV=development npm --prefix "$atom_root" ci --include=dev
  as_soul npm --prefix "$atom_root" run build
  # corepack picks the project from the working directory.
  as_soul bash -ec 'cd "$1/dashboard"; corepack pnpm install --frozen-lockfile --prod=false; corepack pnpm run build' bash "$atom_root"
}
init_atom() {
  local atom_root=$1 fresh frontend=http://127.0.0.1:4200
  if [[ "${TAILSCALE:-false}" == true ]]; then frontend=https://${TAILSCALE_DNS}:8443; fi
  fresh=$(mktemp)
  cat > "$fresh" <<ENV
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4200
DATABASE_URL=postgresql://soulstream:${DB_PASSWORD}@127.0.0.1:5432/atom
JWT_SECRET=${ATOM_JWT_SECRET}
DASHBOARD_ADMIN_PASSWORD=${ADMIN_PASSWORD}
DASHBOARD_DIR=${atom_root}/dashboard/dist
FRONTEND_URL=${frontend}
ENV
  merge_env "$atom_root/.env" "$fresh" 'NODE_ENV API_HOST API_PORT DATABASE_URL JWT_SECRET DASHBOARD_ADMIN_PASSWORD DASHBOARD_DIR FRONTEND_URL'
  rm -f "$fresh"
  chown soulstream:soulstream "$atom_root/.env"
  # migrate reads <atom_root>/.env, so it runs after the file is written.
  as_soul npm --prefix "$atom_root" run migrate
  sudo -u postgres psql -d atom -tAc "SELECT current_database() = 'atom' AND to_regclass('public.cards') IS NOT NULL AND to_regclass('public.agents') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'scope');" | grep -qx t
}
write_atom_unit() {
  local unit_dir=$1 atom_root=$2
  cat > "$unit_dir/soulstream-atom.service" <<UNIT
[Unit]
Description=Soulstream atom
After=network.target postgresql.service
Before=soulstream-orch.service soulstream-worker.service
[Service]
User=soulstream
WorkingDirectory=$atom_root
EnvironmentFile=$atom_root/.env
Environment=HOME=/home/soulstream
Environment=PATH=/home/soulstream/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node $atom_root/dist/api/index.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
}
start_atom() {
  local atom_root=$1 deadline
  write_atom_unit /etc/systemd/system "$atom_root"
  systemctl daemon-reload
  systemctl enable soulstream-atom.service
  systemctl restart soulstream-atom.service
  deadline=$((SECONDS+60))
  until [[ "$(curl --max-time 3 -s -o /dev/null -w '%{http_code}' "$ATOM_URL/api/health" 2>/dev/null)" == 200 ]]; do
    if ((SECONDS >= deadline)); then journalctl -u soulstream-atom.service -n 50 --no-pager; return 1; fi
    sleep 2
  done
}
# Prints the HTTP status of the agent-key outline for the header file in $1 (000 on network errors).
atom_outline_status() {
  curl --max-time 10 -s -o /dev/null -w '%{http_code}' -H "@$1" "$ATOM_URL/api/tree/outline" 2>/dev/null || true
}
# Every return is explicit: the caller runs this with errexit suspended to clean up.
issue_atom_api_key_in() {
  local root=$1 work=$2 key_file=$1/.atom-api-key header=$2/header cookie=$2/cookie response=$2/response fresh status key agent_id
  { : > "$header" && chmod 600 "$header" && : > "$cookie" && chmod 600 "$cookie" && : > "$response" && chmod 600 "$response"; } || return 1
  if [[ -s "$key_file" ]]; then
    key=$(<"$key_file") || return 1
    if [[ ! "$key" =~ $ATOM_API_KEY_RE ]]; then printf 'Stored atom API key has an unexpected format.\n' >&2; return 1; fi
    printf 'x-api-key: %s\n' "$key" > "$header" || return 1
    status=$(atom_outline_status "$header")
    case "$status" in
      200) printf 'Existing atom API key accepted.\n'; return 0 ;;
      401) printf 'Existing atom API key was rejected; issuing a new key.\n' ;;
      *) printf 'Atom API key check failed with HTTP %s.\n' "$status" >&2; return 1 ;;
    esac
  fi
  status=$(jq -Rs '{password: (sub("^\\s+"; "") | sub("\\s+$"; ""))}' < "$root/.admin-password" |
    curl --max-time 30 -s -o /dev/null -w '%{http_code}' -c "$cookie" -X POST -H 'Content-Type: application/json' --data-binary @- "$ATOM_URL/api/auth/password-login" 2>/dev/null) || true
  if [[ "$status" != 200 ]]; then printf 'Atom password login failed with HTTP %s.\n' "$status" >&2; return 1; fi
  # agent_id is unique in atom; the timestamp keeps reissued keys apart.
  agent_id=soulstream-$(date -u +%Y%m%d%H%M%S)
  status=$(jq -n --arg id "$agent_id" '{agent_id: $id, display_name: "Soulstream", scope: "write"}' |
    curl --max-time 30 -s -o "$response" -w '%{http_code}' -b "$cookie" -X POST -H 'Content-Type: application/json' --data-binary @- "$ATOM_URL/api/config/agents" 2>/dev/null) || true
  if [[ "$status" != 201 ]]; then printf 'Atom API key issuance failed with HTTP %s.\n' "$status" >&2; return 1; fi
  fresh=$(mktemp "$key_file.XXXXXX") || return 1
  if ! jq -er .secret < "$response" > "$fresh" 2>/dev/null; then rm -f "$fresh"; printf 'Atom API key issuance returned no key.\n' >&2; return 1; fi
  key=$(<"$fresh")
  # The key goes into env files verbatim.
  if [[ ! "$key" =~ $ATOM_API_KEY_RE ]]; then rm -f "$fresh"; printf 'Issued atom API key has an unexpected format.\n' >&2; return 1; fi
  if ! { chmod 600 "$fresh" && chown soulstream:soulstream "$fresh" && mv "$fresh" "$key_file"; }; then rm -f "$fresh"; return 1; fi
  printf 'x-api-key: %s\n' "$key" > "$header" || return 1
  status=$(atom_outline_status "$header")
  if [[ "$status" != 200 ]]; then printf 'New atom API key was rejected with HTTP %s.\n' "$status" >&2; return 1; fi
  printf 'Issued atom API key for %s.\n' "$agent_id"
}
issue_atom_api_key() {
  local root=$1 work status=0
  work=$(mktemp -d) || return 1
  issue_atom_api_key_in "$root" "$work" || status=$?
  rm -rf "$work"
  return "$status"
}
load_atom_instructions() {
  local root=$1 output status=0 line
  mkdir -p "$root/config"
  chown soulstream:soulstream "$root/config"
  output=$(as_soul node "$root/install/seed/load_atom_seed.mjs" --atom-url "$ATOM_URL" --password-file "$root/.admin-password" --state-dir "$root/config") || status=$?
  if [[ -n "$output" ]]; then printf '%s\n' "$output"; fi
  while IFS= read -r line; do
    if [[ "$line" == 'WARNING: '* ]]; then ATOM_SEED_WARNINGS+="${line#WARNING: }"$'\n'; fi
  done <<< "$output"
  return "$status"
}
write_configuration() {
  local home=$1 root=$2
  render_config "$home" "$root"
  chown -R soulstream:soulstream "$root/config" "$root/.env.orch" "$root/.env.soul-server-ts" "$root/.local" "$home/workspace"
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
        (first(.nodes[]? | select(.nodeId == "local")) // null) as $node |
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
  local root=$1 line
  printf '\nInstalled %s; backends: %s\n' "$(as_soul git -C "$root" rev-parse --short=12 HEAD)" "$BACKENDS"
  if [[ "$TAILSCALE" == true ]]; then
    printf 'Open https://%s from a tailnet device signed in as %s.\n' "$TAILSCALE_DNS" "$TAILSCALE_USER"
    printf 'Local processes on this server can forge identity headers.\n'
    printf 'Remove access: tailscale serve reset && tailscale logout\n'
    printf 'Atom: https://%s:8443 (password: sudo cat %s/.admin-password)\n' "$TAILSCALE_DNS" "$root"
  else
    printf 'Connect: ssh -L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200 <user>@<server>\n'
    printf 'Soulstream: http://127.0.0.1:5200\n'
    printf 'Atom: http://127.0.0.1:4200\n'
    printf 'Password for both: sudo cat %s/.admin-password\n' "$root"
  fi
  printf 'PAS: create a persistent session in the Soulstream dashboard; it uses 서소영 (PAS) by default.\n'
  if [[ -n "${ATOM_SEED_WARNINGS:-}" ]]; then
    printf 'Atom instructions:\n'
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then printf '  %s\n' "$line"; fi
    done <<< "$ATOM_SEED_WARNINGS"
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
  local home=/home/soulstream root=/home/soulstream/soulstream atom_root=/home/soulstream/atom
  exec 3>&2
  LOG=/var/log/soulstream-install.log; STEP=setup
  touch "$LOG"; chmod 600 "$LOG"; trap on_error ERR
  run_step 'Installing packages' install_packages
  if [[ "$TAILSCALE" == true ]]; then STEP='Setting up Tailscale'; printf '%s\n' "$STEP"; setup_tailscale; fi
  run_step 'Setting up account' setup_account
  run_step 'Installing Node.js' install_node
  run_step 'Installing selected CLIs' install_clis
  run_step 'Cloning repositories' clone_repositories "$root" "$atom_root"
  run_step 'Preparing secrets' setup_secrets "$root" "$atom_root"
  run_step 'Preparing databases' setup_database
  run_step 'Building atom' build_atom "$atom_root"
  run_step 'Initializing atom' init_atom "$atom_root"
  run_step 'Starting atom' start_atom "$atom_root"
  run_step 'Issuing atom API key' issue_atom_api_key "$root"
  run_step 'Loading atom instructions' load_atom_instructions "$root"
  # The worker build hashes .env.soul-server-ts, so its atom values are final before building.
  run_step 'Writing configuration' write_configuration "$home" "$root"
  run_step 'Building Soulstream' build_project "$root"
  run_step 'Initializing schema' setup_schema "$root"
  run_step 'Starting services' install_units "$root"
  if [[ "$TAILSCALE" == true ]]; then run_step 'Enabling Tailscale Serve' setup_tailscale_serve; fi
  run_step 'Checking services and workspace' wait_and_create_workspace "$root"
  run_step 'Checking model presets' refresh_model_presets "$root"
  finish_message "$root"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
