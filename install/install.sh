#!/usr/bin/env bash

# Secrets pass through shell variables, so tracing is off for this script and for the shells it starts.
disable_xtrace() {
  { set +x; export -n SHELLOPTS 2>/dev/null || true; } 2>/dev/null
  return 0
}
disable_xtrace

# Atom listens on loopback; tests point this at a fake server.
ATOM_URL=http://127.0.0.1:4200
ATOM_API_KEY_RE='^[A-Za-z0-9._~+/=-]+$'
ATOM_SEED_WARNINGS=
INSTALL_LANG=ko
INSTALL_SOURCE=
# Exported seed names that configuration reads from config/.atom-seed-map.json.
ATOM_SEED_NAMES='skill_catalog domain_catalog common_rules common_rules_extra codex_rules claude_common_rules coding_common_rules coding_common_rules_extra seosoyoung_rules seosoyoung_general seosoyoung_skills seosoyoung_rules_pas seosoyoung_skills_pas seosoyoung_rules_extra_pas card_orchestrator_root'
# Tests reassign these three after sourcing.
SOULSTREAM_REPO_URL=https://github.com/eiaserinnys/soulstream.git
ATOM_REPO_URL=https://github.com/eiaserinnys/atom.git
# The branch each repository follows when --ref or --atom-ref is not given: the verified channel. Tests reassign these after sourcing.
DEFAULT_SOULSTREAM_REF=beta
DEFAULT_ATOM_REF=beta
# Absolute path of the installer file that is running, set by main before it changes directory. Tests reassign it after sourcing.
RUNNING_INSTALLER=
SYSTEMD_DIR=/etc/systemd/system
# Records what this installer added under /usr/local so uninstall.sh removes only that. Tests reassign these after sourcing.
RECEIPT_FILE=/etc/soulstream/install-receipt.json
USR_LOCAL=/usr/local
# Debian's base-files makes the shared /usr/local directories root:staff when this file exists, root:root otherwise. Tests reassign it.
STAFF_MARKER=/etc/staff-group-for-usr-local
# Shared /usr/local directories (relative to USR_LOCAL, . is USR_LOCAL itself) whose owner install_node corrects. uninstall.sh keeps the same list.
USR_LOCAL_DIRS='. bin lib include share share/man share/man/man1 share/doc lib/node_modules'
# What the Node.js tarball puts in /usr/local, the same set as NODE_BUNDLE in uninstall.sh plus bin/node.
NODE_TARBALL_PATHS='bin/node bin/npm bin/npx bin/corepack lib/node_modules/npm lib/node_modules/corepack include/node share/doc/node share/man/man1/node.1 CHANGELOG.md LICENSE README.md'
NODE_VERSION=v22.23.5
# Stopped in this order when maintenance starts and after a failure during it.
SERVICE_UNITS='soulstream-worker.service soulstream-orch.service soulstream-atom.service'
MAINTENANCE_ENTERED=false
INSTALL_ROOT=
MANAGED_CONFIG_WARNINGS=
# One rule for the administrator password shared by Soulstream and atom. The five excluded characters are read
# differently by systemd EnvironmentFile=, dotenv and the installer's own env readers; leading and trailing spaces
# are trimmed by atom but not by Soulstream.
PASSWORD_RULE_MESSAGE="Invalid administrator password: use 8 to 128 printable ASCII characters on a single line, with no leading or trailing space and none of # \\ ' \" \`"
FORBIDDEN_PASSWORD_CHARS='#\'\''"`'
ADMIN_PASSWORD_FILE=
SET_ADMIN_PASSWORD=false
CHOSEN_ADMIN_PASSWORD=
PASSWORD_SOURCE=
GENERATED_PASSWORD_IS_NEW=false
GENERATED_PASSWORD_SAVED=false
TTY_SAVED_STATE=
# Temporary files that may hold secrets; removed on every exit path.
declare -ga TEMP_FILES=()
# Keyed by soulstream and atom; filled by check_repositories.
declare -gA REPO_PATH=() REPO_PREVIOUS=() REPO_TARGET=() REPO_MODE=() REPO_BRANCH=()
# Keyed by database name; holds the dumps this run confirmed. backup_database runs in this shell, so on_error sees them.
declare -gA BACKUP_PATHS=()
# The atom dump of an update that did not finish, found by protect_atom_backup; empty when the last run completed or its dump is gone.
PROTECTED_ATOM_BACKUP=
# Owner of both databases, and the role a manual restore creates objects as.
DATABASE_OWNER=soulstream
# Loopback port of the worker; its MCP port is the next one. --worker-port moves both.
DEFAULT_WORKER_PORT=4205
WORKER_PORT=$DEFAULT_WORKER_PORT
WORKER_PORT_SET=false
# Addresses the browser uses for the dashboard and atom, from --public-url and --atom-public-url; empty keeps what is installed.
PUBLIC_URL=
ATOM_PUBLIC_URL_OPT=
# Dumps kept per database in <root>/.local/backups.
BACKUP_KEEP=3

register_temp_file() {
  TEMP_FILES+=("$1")
  return 0
}

cleanup_temp_files() {
  if ((${#TEMP_FILES[@]})); then
    rm -f -- "${TEMP_FILES[@]}" 2>/dev/null || true
    TEMP_FILES=()
  fi
  return 0
}

usage() {
  printf 'Usage: install.sh [--backends claude,codex,antigravity] [--lang language] [--ref git-ref] [--atom-ref git-ref] [--worker-port port] [--public-url url] [--atom-public-url url] [--admin-password-file path | --set-admin-password] [--tailscale [--tailscale-auth-key-file path] [--tailscale-user login]] [--help]\n'
  printf '  --backends  comma-separated list of claude, codex, antigravity (default: claude,codex)\n'
  printf '  --lang  installation language: ko|en|ja|zh-Hans when available (default: saved language or system locale)\n'
  printf '  --worker-port  loopback port of the worker, 1024-65534; its MCP port is the next one (default: 4205, or the port of the previous install)\n'
  printf '  --public-url  address the browser opens the dashboard at, such as http://127.0.0.1:15200 (password mode; default: the current address, or http://127.0.0.1:5200)\n'
  printf '  --atom-public-url  address the browser opens atom at, such as http://127.0.0.1:14200 (password mode; default: the current address, or http://127.0.0.1:4200)\n'
}

# Prints the cause on stderr, then the usage, and stops with the argument-error status.
arg_error() {
  printf 'install.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

validate_admin_password() {
  local pw=$1 LC_ALL=C
  if (( ${#pw} < 8 || ${#pw} > 128 )) ||
     [[ "$pw" == ' '* || "$pw" == *' ' || "$pw" =~ [^[:print:]] || "$pw" == *["$FORBIDDEN_PASSWORD_CHARS"]* ]]; then
    printf '%s\n' "$PASSWORD_RULE_MESSAGE" >&2
    return 1
  fi
  return 0
}

# Reads the whole file as bytes. Only a final LF (and the CR before it) is a line end; anything else that is not
# printable ASCII, including a second line or a NUL byte, fails the value rule.
read_admin_password_file() {
  disable_xtrace
  local file=$1 raw orig_bytes LC_ALL=C
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    printf 'Admin password file is not readable.\n' >&2
    return 1
  fi
  orig_bytes=$(wc -c < "$file") || { printf 'Admin password file is not readable.\n' >&2; return 1; }
  # printf x only after a successful cat, so a read error is not mistaken for a value.
  { raw=$(cat -- "$file" && printf x); } 2>/dev/null || { printf 'Admin password file is not readable.\n' >&2; return 1; }
  raw=${raw%x}
  # Command substitution drops NUL bytes; under LC_ALL=C, ${#raw} is the exact byte count that remains.
  if (( orig_bytes != ${#raw} )); then
    printf '%s\n' "$PASSWORD_RULE_MESSAGE" >&2
    return 1
  fi
  if [[ "$raw" == *$'\n' ]]; then
    raw=${raw%$'\n'}
    raw=${raw%$'\r'}
  fi
  validate_admin_password "$raw" || return 1
  CHOSEN_ADMIN_PASSWORD=$raw
  PASSWORD_SOURCE=file
  return 0
}

# An origin: http or https, a host and an optional port; no path and no trailing slash.
valid_origin() { [[ "$1" =~ ^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]]; }

# Succeeds for a password-mode run over an existing password-mode installation, whose addresses may then be kept: the
# installation's mode is TAILSCALE_AUTH_ENABLED in its .env.orch. A Tailscale run never keeps them, because its
# addresses come from the current tailnet name. Reads before the env files are rewritten.
keeps_installed_addresses() {
  local file=$1/.env.orch
  [[ "${TAILSCALE:-false}" != true && -f "$file" ]] || return 1
  [[ "$(read_env_value "$file" TAILSCALE_AUTH_ENABLED)" != true ]]
}

# Prints the first of: the given value, the value in file (when keeps_installed_addresses holds for root), the mode default.
pick_address() {
  local given=$1 root=$2 file=$3 key=$4 default=$5 kept=
  if [[ -n "$given" ]]; then printf '%s' "$given"; return 0; fi
  if [[ -n "$root" ]] && keeps_installed_addresses "$root"; then kept=$(read_env_value "$file" "$key") || return 1; fi
  printf '%s' "${kept:-$default}"
}

valid_worker_port() { [[ "$1" =~ ^[1-9][0-9]{3,4}$ ]] && (( $1 >= 1024 && $1 <= 65534 )); }

# Without --worker-port, a rerun keeps the port of the installation being updated.
resolve_worker_port() {
  local existing
  [[ "$WORKER_PORT_SET" == true ]] && return 0
  existing=$(read_env_value "$1/.env.soul-server-ts" PORT) || return 1
  if [[ -z "$existing" ]]; then WORKER_PORT=$DEFAULT_WORKER_PORT; return 0; fi
  valid_worker_port "$existing" || { printf 'PORT=%s in %s/.env.soul-server-ts is not a port from 1024 to 65534; pass --worker-port.\n' "$existing" "$1" >&2; return 1; }
  WORKER_PORT=$existing
  return 0
}

parse_args() {
  disable_xtrace
  BACKENDS=claude,codex
  REQUESTED_LANG=
  REF=
  REF_SET=false
  ATOM_REF=
  ATOM_REF_SET=false
  WORKER_PORT=$DEFAULT_WORKER_PORT
  WORKER_PORT_SET=false
  PUBLIC_URL=
  ATOM_PUBLIC_URL_OPT=
  TAILSCALE=false
  TAILSCALE_AUTH_KEY=
  TAILSCALE_AUTH_KEY_FILE=
  TAILSCALE_USER=
  ADMIN_PASSWORD_FILE=
  SET_ADMIN_PASSWORD=false
  CHOSEN_ADMIN_PASSWORD=
  PASSWORD_SOURCE=
  GENERATED_PASSWORD_SAVED=false
  while (($#)); do
    case "$1" in
      --help) usage; exit 0 ;;
      --tailscale) TAILSCALE=true; shift ;;
      --set-admin-password) SET_ADMIN_PASSWORD=true; shift ;;
      --backends|--lang|--ref|--atom-ref|--worker-port|--public-url|--atom-public-url|--admin-password-file|--tailscale-auth-key|--tailscale-auth-key-file|--tailscale-user)
        if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then arg_error "$1 needs a value"; fi
        case "$1" in
          --ref) REF=$2; REF_SET=true ;;
          --atom-ref) ATOM_REF=$2; ATOM_REF_SET=true ;;
          --worker-port) valid_worker_port "$2" || arg_error "invalid --worker-port value \"$2\": use an integer from 1024 to 65534"; WORKER_PORT=$2; WORKER_PORT_SET=true ;;
          --public-url) valid_origin "$2" || arg_error "invalid --public-url value \"$2\": use http:// or https:// followed by a host and an optional port, without a path"; PUBLIC_URL=$2 ;;
          --atom-public-url) valid_origin "$2" || arg_error "invalid --atom-public-url value \"$2\": use http:// or https:// followed by a host and an optional port, without a path"; ATOM_PUBLIC_URL_OPT=$2 ;;
          --backends) BACKENDS=$2 ;;
          --lang) REQUESTED_LANG=$2 ;;
          --admin-password-file) ADMIN_PASSWORD_FILE=$2 ;;
          --tailscale-auth-key) TAILSCALE_AUTH_KEY=$2 ;;
          --tailscale-auth-key-file) TAILSCALE_AUTH_KEY_FILE=$2 ;;
          --tailscale-user) TAILSCALE_USER=${2,,} ;;
        esac
        shift 2 ;;
      *) arg_error "unknown option: $1" ;;
    esac
  done
  if [[ "$SET_ADMIN_PASSWORD" == true && -n "$ADMIN_PASSWORD_FILE" ]]; then arg_error "--set-admin-password and --admin-password-file cannot be used together"; fi
  if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
    # The installer changes to / before anything else runs, so the file is read now, from the caller's directory.
    [[ "$ADMIN_PASSWORD_FILE" == /* ]] || ADMIN_PASSWORD_FILE=$PWD/$ADMIN_PASSWORD_FILE
    read_admin_password_file "$ADMIN_PASSWORD_FILE" || exit 2
  fi
  if [[ "$TAILSCALE" == true && ( -n "$PUBLIC_URL" || -n "$ATOM_PUBLIC_URL_OPT" ) ]]; then arg_error "--public-url and --atom-public-url cannot be used with --tailscale; the addresses come from the tailnet name"; fi
  if [[ "$TAILSCALE" != true && ( -n "$TAILSCALE_AUTH_KEY" || -n "$TAILSCALE_AUTH_KEY_FILE" || -n "$TAILSCALE_USER" ) ]]; then arg_error "--tailscale-auth-key, --tailscale-auth-key-file and --tailscale-user need --tailscale"; fi
  if [[ -n "$TAILSCALE_AUTH_KEY" && -n "$TAILSCALE_AUTH_KEY_FILE" ]]; then arg_error "--tailscale-auth-key and --tailscale-auth-key-file cannot be used together"; fi
  if [[ -n "$TAILSCALE_AUTH_KEY_FILE" ]]; then
    if [[ ! -f "$TAILSCALE_AUTH_KEY_FILE" || ! -r "$TAILSCALE_AUTH_KEY_FILE" ]]; then printf 'Tailscale auth key file is not readable.\n' >&2; exit 2; fi
    # The installer changes to / before Tailscale starts, so keep the path absolute.
    [[ "$TAILSCALE_AUTH_KEY_FILE" == /* ]] || TAILSCALE_AUTH_KEY_FILE=$PWD/$TAILSCALE_AUTH_KEY_FILE
  fi
  local item normalized= remaining=$BACKENDS
  while :; do
    item=${remaining%%,*}
    case "$item" in claude|codex|antigravity) ;; *) arg_error "invalid --backends value \"$BACKENDS\": \"$item\" is not one of claude, codex, antigravity" ;; esac
    if [[ ",$normalized," != *",$item,"* ]]; then normalized=${normalized:+$normalized,}$item; fi
    [[ "$remaining" == *,* ]] || break
    remaining=${remaining#*,}
  done
  BACKENDS=$normalized
  return 0
}

has_backend() { [[ ",$BACKENDS," == *",$1,"* ]]; }

# Prints the value of key in an env file; a missing file or key prints nothing. Every return is explicit because
# callers run this where errexit is suspended.
read_env_value() {
  local file=$1 key=$2 value
  [[ -f "$file" ]] || return 0
  value=$(awk -v key="$key" 'index($0,key "=")==1 { value=substr($0,length(key)+2) } END { print value }' "$file") || return 1
  value=${value#\"}; value=${value%\"}
  printf '%s' "$value"
  return 0
}

# The administrator password already on this server. <root>/.admin-password is the source of truth: setup_secrets
# rewrites it first, so after a failed password change a plain rerun finishes with the new value.
read_existing_admin_password() {
  disable_xtrace
  local root=$1 atom_root=$2 existing=
  if [[ -f "$root/.admin-password" ]]; then
    existing=$(<"$root/.admin-password") || return 1
  fi
  if [[ -z "$existing" ]]; then existing=$(read_env_value "$root/.env.orch" DASHBOARD_ADMIN_PASSWORD) || return 1; fi
  if [[ -z "$existing" ]]; then existing=$(read_env_value "$atom_root/.env" DASHBOARD_ADMIN_PASSWORD) || return 1; fi
  printf '%s' "$existing"
  return 0
}

restore_tty_echo() {
  if [[ -n "${TTY_SAVED_STATE:-}" ]]; then
    stty "$TTY_SAVED_STATE" <&4 2>/dev/null || stty "$TTY_SAVED_STATE" </dev/tty 2>/dev/null || stty echo </dev/tty 2>/dev/null || true
    TTY_SAVED_STATE=
  fi
  return 0
}

# Turns echo off on fd 4. Fails, with echo restored, unless the state was saved and echo is really off.
hide_tty_echo() {
  local saved
  if ! saved=$(stty -g <&4 2>/dev/null) || [[ -z "$saved" ]]; then
    return 1
  fi
  TTY_SAVED_STATE=$saved
  if ! stty -echo <&4 2>/dev/null; then
    restore_tty_echo
    return 1
  fi
  return 0
}

on_password_prompt_signal() {
  local code=$1
  restore_tty_echo
  { exec 4<&- 4>&-; } 2>/dev/null || true
  cleanup_temp_files
  printf '\nAborted.\n' >&2
  exit "$code"
}

# Asks twice on fd 4 (/dev/tty). Enter at the first prompt means: generate one (PASSWORD_SOURCE=generated_tty).
prompt_admin_password_on_tty() {
  disable_xtrace
  local attempt pw1 pw2 rc=1
  local prev_exit prev_int prev_term prev_hup
  prev_exit=$(trap -p EXIT); prev_int=$(trap -p INT); prev_term=$(trap -p TERM); prev_hup=$(trap -p HUP)
  trap 'restore_tty_echo; cleanup_temp_files' EXIT
  trap 'on_password_prompt_signal 130' INT
  trap 'on_password_prompt_signal 143' TERM
  trap 'on_password_prompt_signal 129' HUP

  for ((attempt = 1; attempt <= 3; attempt++)); do
    if ! hide_tty_echo; then
      printf 'Cannot disable terminal echo on /dev/tty. Pass --admin-password-file <path> instead.\n' >&2
      rc=1; break
    fi
    printf 'Administrator password for Soulstream and atom (8-128 chars; press Enter to generate): ' >&4
    if ! IFS= read -r pw1 <&4; then
      restore_tty_echo
      printf '\nAborted.\n' >&2
      rc=1; break
    fi
    printf '\n' >&4
    restore_tty_echo
    pw1=${pw1%$'\r'}

    if [[ -z "$pw1" ]]; then
      CHOSEN_ADMIN_PASSWORD=
      PASSWORD_SOURCE=generated_tty
      printf 'A random administrator password will be generated and shown once at the end of installation.\n' >&4
      rc=0; break
    fi
    if ! validate_admin_password "$pw1" 2>&4; then
      pw1=
      continue
    fi

    if ! hide_tty_echo; then
      printf 'Cannot disable terminal echo on /dev/tty. Pass --admin-password-file <path> instead.\n' >&2
      pw1=; rc=1; break
    fi
    printf 'Confirm administrator password: ' >&4
    if ! IFS= read -r pw2 <&4; then
      restore_tty_echo
      printf '\nAborted.\n' >&2
      pw1=; rc=1; break
    fi
    printf '\n' >&4
    restore_tty_echo
    pw2=${pw2%$'\r'}

    if [[ "$pw1" == "$pw2" ]]; then
      CHOSEN_ADMIN_PASSWORD=$pw1
      PASSWORD_SOURCE=user_tty
      pw1=; pw2=; rc=0; break
    fi
    printf 'Passwords do not match.\n' >&4
    pw1=; pw2=
  done

  if (( rc != 0 && attempt > 3 )); then
    printf 'Too many invalid password attempts.\n' >&2
  fi
  restore_tty_echo
  eval "${prev_exit:-trap - EXIT}"
  eval "${prev_int:-trap - INT}"
  eval "${prev_term:-trap - TERM}"
  eval "${prev_hup:-trap - HUP}"
  return "$rc"
}

# Decides where this run's administrator password comes from, before packages are installed or services stop.
# Sets PASSWORD_SOURCE: file, user_tty, generated_tty, keep (an existing value) or generated_silent.
# A first install asks only when stdin is a terminal and /dev/tty opens; --set-admin-password needs /dev/tty only.
resolve_admin_password() {
  disable_xtrace
  local root=$1 atom_root=$2 existing rc=0
  if [[ "$PASSWORD_SOURCE" == file ]]; then
    return 0
  fi
  if [[ "$SET_ADMIN_PASSWORD" == true ]]; then
    if ! { exec 4<>/dev/tty; } 2>/dev/null; then
      printf 'No interactive terminal available. Pass --admin-password-file <path> instead.\n' >&2
      return 1
    fi
    prompt_admin_password_on_tty || rc=$?
    exec 4<&- 4>&-
    return "$rc"
  fi
  existing=$(read_existing_admin_password "$root" "$atom_root") || return 1
  if [[ -n "$existing" ]]; then
    existing=
    PASSWORD_SOURCE=keep
    return 0
  fi
  if [[ -t 0 ]] && { exec 4<>/dev/tty; } 2>/dev/null; then
    prompt_admin_password_on_tty || rc=$?
    exec 4<&- 4>&-
    return "$rc"
  fi
  PASSWORD_SOURCE=generated_silent
  return 0
}

# Every read and every openssl call is checked: callers run this where errexit is suspended, and an empty secret
# must never reach a file.
prepare_secrets() {
  disable_xtrace
  local root=$1 atom_root=$2 db_url
  GENERATED_PASSWORD_IS_NEW=false
  BEARER=$(read_env_value "$root/.env.orch" AUTH_BEARER_TOKEN) || return 1
  JWT=$(read_env_value "$root/.env.orch" JWT_SECRET) || return 1
  db_url=$(read_env_value "$root/.env.orch" DATABASE_URL) || return 1
  DB_PASSWORD=${db_url#postgresql://soulstream:}; DB_PASSWORD=${DB_PASSWORD%%@*}
  [[ "$db_url" == postgresql://soulstream:*@* ]] || DB_PASSWORD=
  if [[ -z "$BEARER" ]]; then BEARER=$(openssl rand -hex 32) || return 1; fi
  if [[ -z "$JWT" ]]; then JWT=$(openssl rand -hex 32) || return 1; fi
  if [[ -z "$DB_PASSWORD" ]]; then DB_PASSWORD=$(openssl rand -hex 32) || return 1; fi
  # The administrator password signs in to both Soulstream and atom in every mode.
  case "${PASSWORD_SOURCE:-}" in
    file|user_tty)
      ADMIN_PASSWORD=$CHOSEN_ADMIN_PASSWORD ;;
    generated_tty)
      ADMIN_PASSWORD=$(openssl rand -hex 12) || return 1
      GENERATED_PASSWORD_IS_NEW=true ;;
    *)
      ADMIN_PASSWORD=$(read_existing_admin_password "$root" "$atom_root") || return 1
      if [[ -z "$ADMIN_PASSWORD" ]]; then
        ADMIN_PASSWORD=$(openssl rand -hex 12) || return 1
        GENERATED_PASSWORD_IS_NEW=true
      fi ;;
  esac
  ATOM_JWT_SECRET=$(read_env_value "$atom_root/.env" JWT_SECRET) || return 1
  if [[ -z "$ATOM_JWT_SECRET" ]]; then ATOM_JWT_SECRET=$(openssl rand -hex 32) || return 1; fi
  [[ -n "$BEARER" && -n "$JWT" && -n "$DB_PASSWORD" && -n "$ADMIN_PASSWORD" && -n "$ATOM_JWT_SECRET" ]] || return 1
  return 0
}

# The only writer of <root>/.admin-password.
setup_secrets() {
  disable_xtrace
  local root=$1 atom_root=$2 temp
  prepare_secrets "$root" "$atom_root" || return 1
  temp=$(mktemp "$root/.admin-password.XXXXXX") || return 1
  register_temp_file "$temp"
  if ! { printf '%s\n' "$ADMIN_PASSWORD" > "$temp" && chmod 600 "$temp" && chown soulstream:soulstream "$temp" && mv "$temp" "$root/.admin-password"; }; then
    rm -f "$temp"
    return 1
  fi
  # Only a password this run generated needs the hint on_error prints.
  if [[ "$GENERATED_PASSWORD_IS_NEW" == true ]]; then GENERATED_PASSWORD_SAVED=true; fi
  return 0
}

# Remove keys owned by the installer, preserving every other line verbatim. Nothing is replaced unless every step
# worked, and the temporary file never outlives a failure.
merge_env() {
  local target=$1 fresh=$2 managed=$3 temp
  temp=$(mktemp "${target}.XXXXXX") || return 1
  register_temp_file "$temp"
  if [[ -f "$target" ]]; then
    if ! awk -v keys="$managed" 'BEGIN { n=split(keys,a," "); for(i=1;i<=n;i++) owned[a[i]]=1 }
      { line=$0; sub(/=.*/,"",line); if (!(line in owned)) print }' "$target" > "$temp"; then
      rm -f "$temp"
      return 1
    fi
  fi
  if ! { cat "$fresh" >> "$temp" && chmod 600 "$temp" && mv "$temp" "$target"; }; then
    rm -f "$temp"
    return 1
  fi
  return 0
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

# install_defaults is a JSON flow mapping in the YAML catalog; jq is installed
# before configuration and does not require the project's node_modules.
load_install_defaults() {
  local catalog=$1 defaults
  defaults=$(awk '/^install_defaults: / { sub(/^install_defaults: /, ""); print; found=1; exit } END { if (!found) exit 1 }' "$catalog") || {
    printf 'Cannot read install_defaults from model-catalog: %s\n' "$catalog" >&2; return 1;
  }
  if ! jq -e '(.backends | [.claude, .codex, .antigravity]) + [.profiles["card-orchestrator"]] | all(.[]; type == "string" and length > 0)' <<< "$defaults" >/dev/null; then
    printf 'Invalid install_defaults in model-catalog: %s\n' "$catalog" >&2; return 1
  fi
  INSTALL_DEFAULTS=$defaults
}

backend_preset() { jq -er --arg backend "$1" '.backends[$backend]' <<< "$INSTALL_DEFAULTS"; }

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

installer_text_path() {
  local install_dir=$INSTALL_SOURCE
  if [[ -z "$install_dir" ]]; then install_dir=$(dirname -- "${BASH_SOURCE[0]}") || return 1; fi
  printf '%s/seed/locales/%s/installer.json' "$install_dir" "$INSTALL_LANG"
}

render_agents() {
  local home=$1 root=$2 first=${BACKENDS%%,*} backend name rules
  local profile_names
  profile_names=$(jq -er --arg lang "$INSTALL_LANG" '
    .profiles | [.seosoyoung, ."seosoyoung-pas", ."card-orchestrator"] |
    .[] | if $lang == "ko" then . else tojson end
  ' "$(installer_text_path)") || return 1
  local -a localized_names
  mapfile -t localized_names <<< "$profile_names"
  rules=$(backend_rules_context "$first")
  printf 'agents:\n'
  cat <<YAML
  - id: seosoyoung
    name: ${localized_names[0]}
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
    name: ${localized_names[1]}
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
    name: ${localized_names[2]}
    backend: claude
    default_preset: $(jq -er '.profiles["card-orchestrator"]' <<< "$INSTALL_DEFAULTS")
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

# Copies the bundled skill scripts into the shared folder. Files the user added there are kept; files with the same
# path as a bundled file are replaced on every run.
sync_common_files() {
  local root=$1 source=$1/install/common-files
  [[ -d "$source" ]] || { printf 'Missing bundled skill scripts: %s\n' "$source" >&2; return 1; }
  cp -a "$source/." "$root/.local/agent-common/"
}

# Sets DASHBOARD_URL, DASHBOARD_CORS and ATOM_URL_FOR_BROWSER for the orchestrator env file: the option, else the
# installed value of the same mode, else the mode default.
resolve_public_urls() {
  local root=$1 default_url default_cors default_atom origin url cors= kept
  if [[ "${TAILSCALE:-false}" == true ]]; then
    default_url=https://${TAILSCALE_DNS}; default_cors=https://${TAILSCALE_DNS},http://127.0.0.1:5200; default_atom=https://${TAILSCALE_DNS}:8443
  else
    default_url=http://127.0.0.1:5200; default_cors=http://127.0.0.1:5200,http://localhost:5200; default_atom=http://127.0.0.1:4200
  fi
  DASHBOARD_URL=$(pick_address "${PUBLIC_URL:-}" "$root" "$root/.env.orch" SOULSTREAM_PUBLIC_URL "$default_url") || return 1
  ATOM_URL_FOR_BROWSER=$(pick_address "${ATOM_PUBLIC_URL_OPT:-}" "$root" "$root/.env.orch" ATOM_PUBLIC_URL "$default_atom") || return 1
  if [[ -n "${PUBLIC_URL:-}" ]]; then
    for origin in "$PUBLIC_URL" ${default_cors//,/ }; do
      [[ ",$cors," == *",$origin,"* ]] || cors=${cors:+$cors,}$origin
    done
    DASHBOARD_CORS=$cors
  else
    DASHBOARD_CORS=$(pick_address '' "$root" "$root/.env.orch" CORS_ALLOWED_ORIGINS "$default_cors") || return 1
  fi
}

# Uses the secrets chosen by setup_secrets and the database password from it.
render_config() {
  local home=$1 root=$2 fresh_orch fresh_worker atom_api_key previous_backends work claude
  local -A ATOM_NODES=()
  load_install_defaults "$root/packages/model-catalog/data/model-catalog.yaml" || return 1
  # The backends of the installation being updated, read before the env files are rewritten.
  previous_backends=$(read_env_value "$root/.env.soul-server-ts" SOULSTREAM_BACKENDS)
  [[ -n "$previous_backends" ]] || previous_backends=$BACKENDS
  resolve_worker_port "$root" || return 1
  resolve_public_urls "$root" || return 1
  MANAGED_CONFIG_WARNINGS=
  read_atom_seed_map "$root/config/.atom-seed-map.json" || return 1
  atom_api_key=$(read_atom_api_key "$root/.atom-api-key") || return 1
  mkdir -p "$root/config" "$home/workspace/.projects" "$home/workspace/.local/tmp" "$home/workspace/.local/artifacts" "$root/.local/agent-common"
  sync_common_files "$root" || return 1
  fresh_orch=$(mktemp) || return 1
  register_temp_file "$fresh_orch"
  fresh_worker=$(mktemp) || { rm -f "$fresh_orch"; return 1; }
  register_temp_file "$fresh_worker"
  # One chain: a failed write or a failed merge leaves the existing env files untouched and removes both temporary files.
  if ! {
    cat > "$fresh_orch" <<ENV &&
ENVIRONMENT=production
HOST=127.0.0.1
PORT=5200
DEFAULT_EXECUTION_NODE_ID=local
DEFAULT_PAS_AGENT_ID=seosoyoung-pas
PERSISTENT_SESSION_BOOTSTRAP=true
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
SOULSTREAM_PUBLIC_URL=${DASHBOARD_URL}
CORS_ALLOWED_ORIGINS=${DASHBOARD_CORS}
ATOM_PUBLIC_URL=${ATOM_URL_FOR_BROWSER}
TAILSCALE_AUTH_ENABLED=true
TAILSCALE_ALLOWED_LOGIN=${TAILSCALE_USER}
ENV
    else
      cat >> "$fresh_orch" <<ENV &&
SOULSTREAM_PUBLIC_URL=${DASHBOARD_URL}
CORS_ALLOWED_ORIGINS=${DASHBOARD_CORS}
ATOM_PUBLIC_URL=${ATOM_URL_FOR_BROWSER}
ENV
      # printf, not a heredoc: the password is written byte for byte.
      printf 'DASHBOARD_ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >> "$fresh_orch"
    fi &&
    { ! has_backend antigravity || printf 'AGY_CLI_PATH=%s/.local/bin/agy\n' "$home" >> "$fresh_orch"; } &&
    cat > "$fresh_worker" <<ENV &&
ENVIRONMENT=production
SOULSTREAM_NODE_ID=local
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:5200/ws/node
SOULSTREAM_BACKENDS=${BACKENDS}
AUTH_BEARER_TOKEN=${BEARER}
JWT_SECRET=${JWT}
PORTABLE_LOCAL_MCP_AUTHORIZATION="Bearer ${BEARER}"
HOST=127.0.0.1
PORT=${WORKER_PORT}
MCP_INTERNAL_PORT=$((WORKER_PORT + 1))
MCP_ENABLED=true
MCP_PATH=/mcp
MCP_REQUIRE_AUTH=true
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
AGENTS_CONFIG_PATH=${root}/config/agents.yaml
AGENT_COMMON_FILES_DIR=${root}/.local/agent-common
EVENT_OUTBOX_DIR=${root}/.local/event-outbox
INCOMING_FILE_DIR=${root}/.local/incoming
SOUL_RUNNER_PROCESS_ENABLED=true
SOUL_RUNNER_STATE_DIR=${root}/.local/r
SOUL_RUNNER_ARTIFACT_DIR=${root}/soul-server-ts/dist/runner
SOUL_RUNNER_RELEASES_DIR=${root}/.local/runner-releases
WORKTREE_MCP_ENABLED=true
WORKTREE_PROJECTS_ROOT=${home}/workspace/.projects
SESSION_ISOLATION_MODE=off
CLAUDE_ACCOUNT_POOL_ENABLED=true
ATOM_ENABLED=true
ATOM_SERVER_URL=http://127.0.0.1:4200
ATOM_API_KEY=${atom_api_key}
ENV
    { ! has_backend claude || printf 'CLAUDE_AUTH_TOKEN_PATH=%s/.claude/.credentials.json\n' "$home" >> "$fresh_worker"; } &&
    { ! has_backend codex || printf 'CODEX_ADAPTER_MODE=app-server\n' >> "$fresh_worker"; } &&
    merge_env "$root/.env.orch" "$fresh_orch" 'ENVIRONMENT HOST PORT DEFAULT_EXECUTION_NODE_ID DEFAULT_PAS_AGENT_ID PERSISTENT_SESSION_BOOTSTRAP DATABASE_URL DASHBOARD_DIR SOULSTREAM_PUBLIC_URL CORS_ALLOWED_ORIGINS AUTH_BEARER_TOKEN JWT_SECRET DASHBOARD_ADMIN_PASSWORD TAILSCALE_AUTH_ENABLED TAILSCALE_ALLOWED_LOGIN ATOM_ENABLED ATOM_SERVER_URL ATOM_PUBLIC_URL ATOM_API_KEY SKILL_CATALOG_NODE_ID DOMAIN_CATALOG_NODE_ID AGY_CLI_PATH' &&
    merge_env "$root/.env.soul-server-ts" "$fresh_worker" 'ENVIRONMENT SOULSTREAM_NODE_ID SOULSTREAM_UPSTREAM_URL SOULSTREAM_BACKENDS AUTH_BEARER_TOKEN JWT_SECRET PORTABLE_LOCAL_MCP_AUTHORIZATION HOST PORT MCP_INTERNAL_PORT MCP_ENABLED MCP_PATH MCP_REQUIRE_AUTH MCP_ALLOWED_HOSTS AGENTS_CONFIG_PATH AGENT_COMMON_FILES_DIR EVENT_OUTBOX_DIR INCOMING_FILE_DIR SOUL_RUNNER_PROCESS_ENABLED SOUL_RUNNER_STATE_DIR SOUL_RUNNER_ARTIFACT_DIR SOUL_RUNNER_RELEASES_DIR WORKTREE_MCP_ENABLED WORKTREE_PROJECTS_ROOT SESSION_ISOLATION_MODE CLAUDE_ACCOUNT_POOL_ENABLED ATOM_ENABLED ATOM_SERVER_URL ATOM_API_KEY CLAUDE_AUTH_TOKEN_PATH CODEX_ADAPTER_MODE CLAUDE_CODE_EXECPATH CODEX_CLI_PATH AGY_CLI_PATH DISABLE_AUTOUPDATER'
  }; then
    rm -f "$fresh_orch" "$fresh_worker"
    return 1
  fi
  rm -f "$fresh_orch" "$fresh_worker"
  work=$(mktemp -d)
  render_agents "$home" "$root" > "$work/agents" || { rm -rf "$work"; return 1; }
  cat > "$work/mcp-registry" <<YAML
servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:${WORKER_PORT}/mcp
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
  cat > "$work/mcp-profiles" <<'YAML'
profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream, atom]
  - id: pas
    name: PAS
    mcp_servers: [soulstream, atom]
YAML
  cat > "$work/agents-md" <<'MARKDOWN'
# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under `.projects/<repository>--<branch>`.
Keep temporary scripts in `.local/tmp` and work products in `.local/artifacts`.
Scripts of shared and custom skills live under `$AGENT_COMMON_FILES_DIR/skills/<skill>/`.
The `soulstream` MCP server provides session and workspace tools.
The `atom` MCP server holds your instructions and skills. Rules live under `에이전트 > 공통 > rules` and skills under `에이전트 > 공통 > skills`.
Find skills with `search_skills` and read them with `load_skill`. Read any other atom node with `compile_subtree`.
MARKDOWN
  write_managed_configs "$home" "$root" "$work" "$previous_backends" || return 1
  rm -rf "$work"
  claude=$home/workspace/CLAUDE.md
  if [[ ! -e "$claude" && ! -L "$claude" ]] || { [[ -L "$claude" ]] && [[ "$(readlink "$claude")" == AGENTS.md || "$(readlink "$claude")" == "$home/workspace/AGENTS.md" ]]; }; then
    ln -sfn AGENTS.md "$claude"
  else
    MANAGED_CONFIG_WARNINGS+="Kept your ${claude}."$'\n'
  fi
}

# The four managed files as the first-stage installer (d785f798, before atom support) wrote them, byte for byte.
stage1_managed_output() {
  local kind=$1 home=$2 backends=$3 preset_file=$4 backend name= preset= IFS=,
  case "$kind" in
    agents)
      printf 'agents:\n'
      for backend in $backends; do
        case "$backend" in
          claude) name=Claude ;;
          codex) name=Codex ;;
          antigravity) name=Antigravity ;;
        esac
        preset=$(jq -er --arg backend "$backend" '.[$backend] | select(type == "string" and length > 0)' "$preset_file") || return 1
        cat <<YAML
  - id: ${backend}-default
    name: ${name}
    backend: ${backend}
    default_preset: ${preset}
    workspace_dir: ${home}/workspace
    mcp_profile: default
YAML
      done ;;
    mcp-registry)
      cat <<'YAML'
servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:4205/mcp
    headers:
      Authorization:
        env: PORTABLE_LOCAL_MCP_AUTHORIZATION
YAML
      ;;
    mcp-profiles)
      cat <<'YAML'
profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream]
YAML
      ;;
    agents-md)
      cat <<'MARKDOWN'
# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under `.projects/<repository>--<branch>`.
The `soulstream` MCP server provides session and workspace tools.
Atom is disabled on this installation; do not call `search_skills` or `load_skill`.
MARKDOWN
      ;;
  esac
}

# Writes the new content from <work>/<kind> unless you edited the file, then records the hashes.
# An edited file is kept and the new content goes to <file>.installer-new; its record line stays as it was.
write_managed_configs() {
  local home=$1 root=$2 work=$3 previous_backends=$4 record=$2/config/.installer-managed.sha256 lines= item kind file recorded current temp
  for item in "agents=$root/config/agents.yaml" "mcp-registry=$root/config/mcp-registry.yaml" "mcp-profiles=$root/config/mcp-profiles.yaml" "agents-md=$home/workspace/AGENTS.md"; do
    kind=${item%%=*}; file=${item#*=}; recorded=; current=
    if [[ -f "$record" ]]; then recorded=$(awk -v path="$file" 'substr($0, 67) == path { print substr($0, 1, 64) }' "$record") || return 1; fi
    if [[ -e "$file" ]]; then current=$(sha256sum < "$file") || return 1; current=${current%% *}; fi
    if [[ -e "$file" && -z "$recorded" ]] && ! cmp -s "$file" "$work/$kind"; then
      stage1_managed_output "$kind" "$home" "$previous_backends" "$root/install/stage1-managed-presets.json" > "$work/stage1" || return 1
    fi
    if [[ ! -e "$file" ]] || cmp -s "$file" "$work/$kind" || [[ -n "$recorded" && "$current" == "$recorded" ]] ||
       { [[ -z "$recorded" ]] && cmp -s "$work/stage1" "$file"; }; then
      if ! cmp -s "$file" "$work/$kind"; then cat "$work/$kind" > "$file" || return 1; fi
      lines+="$(sha256sum "$file")"$'\n' || return 1
    else
      cat "$work/$kind" > "$file.installer-new" || return 1
      MANAGED_CONFIG_WARNINGS+="Kept your ${file}; the installer's version is in ${file}.installer-new."$'\n'
      if [[ -n "$recorded" ]]; then lines+="${recorded}  ${file}"$'\n'; fi
    fi
  done
  temp=$(mktemp "$record.XXXXXX") || return 1
  if ! { printf '%s' "$lines" > "$temp" && chmod 644 "$temp" && mv "$temp" "$record"; }; then rm -f "$temp"; return 1; fi
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

# A new VM still runs apt from cloud-init right after boot. apt-get update fails at once on the lists lock held there
# (DPkg::Lock::Timeout does not cover it), so wait for cloud-init first; the timeout keeps a run started from cloud-init itself from hanging.
install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  if command -v cloud-init >/dev/null; then timeout 300 cloud-init status --wait >/dev/null 2>&1 || true; fi
  apt-get update
  apt-get -o DPkg::Lock::Timeout=300 install -y sudo tmux curl ca-certificates git jq openssl build-essential python3 gh postgresql-17
}
setup_account() {
  id soulstream >/dev/null 2>&1 || useradd -m -d /home/soulstream -s /bin/bash soulstream
  if [[ -f /root/.ssh/authorized_keys && ! -e /home/soulstream/.ssh/authorized_keys ]]; then
    install -d -m 700 -o soulstream -g soulstream /home/soulstream/.ssh
    install -m 600 -o soulstream -g soulstream /root/.ssh/authorized_keys /home/soulstream/.ssh/authorized_keys
  fi
}
# The receipt lists the /usr/local items this installer created. Fields only ever turn on (or grow); a
# rerun never forgets something an earlier run added. A failed write stops the install.
receipt_write() {
  local dir=${RECEIPT_FILE%/*} temp
  mkdir -p "$dir" && chmod 700 "$dir" || return 1
  temp=$(mktemp "$dir/.install-receipt.XXXXXX") || return 1
  if ! { cat > "$temp" && chmod 600 "$temp" && mv "$temp" "$RECEIPT_FILE"; }; then rm -f "$temp"; return 1; fi
}
receipt_init() {
  [[ -e "$RECEIPT_FILE" ]] && return 0
  printf '%s\n' '{"schema":1,"node_tarball_installed":false,"node_version":null,"corepack_shims_created":[],"codex_npm_global_installed":false}' | receipt_write
}
# receipt_update <jq filter> [jq options]
receipt_update() {
  local filter=$1 updated
  shift
  receipt_init || return 1
  updated=$(jq -c "$@" "$filter" "$RECEIPT_FILE") || return 1
  printf '%s\n' "$updated" | receipt_write
}
install_node() {
  local version=$NODE_VERSION archive="node-$NODE_VERSION-linux-x64.tar.gz" dir name node_absent=false node_recorded shims=()
  receipt_init || return 1
  [[ -e "$USR_LOCAL/bin/node" || -L "$USR_LOCAL/bin/node" ]] || node_absent=true
  node_recorded=$(jq -r '.node_tarball_installed' "$RECEIPT_FILE") || return 1
  if [[ "$("$USR_LOCAL/bin/node" --version 2>/dev/null || true)" != "$version" ]]; then
    dir=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/$version/$archive" -o "$dir/$archive"
    curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"
    (cd "$dir" && grep "  $archive$" SHASUMS256.txt | sha256sum -c -)
    # As root, GNU tar would otherwise give the files the owner recorded in the archive and rewrite the owner of directories that already exist.
    tar -xzf "$dir/$archive" -C "$USR_LOCAL" --strip-components=1 --no-same-owner --no-overwrite-dir
    rm -rf "$dir"
    # A node that was already there stays out of the receipt; one this installer put there follows later versions.
    if [[ "$node_absent" == true || "$node_recorded" == true ]]; then
      receipt_update '.node_tarball_installed = true | .node_version = $version' --arg version "$version" || return 1
    fi
  fi
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  for name in pnpm pnpx yarn yarnpkg; do
    [[ -e "$USR_LOCAL/bin/$name" || -L "$USR_LOCAL/bin/$name" ]] || shims+=("$name")
  done
  corepack enable
  local created=()
  for name in "${shims[@]}"; do
    if [[ -L "$USR_LOCAL/bin/$name" ]]; then created+=("$name"); fi
  done
  if ((${#created[@]})); then
    receipt_update '.corepack_shims_created = ((.corepack_shims_created + $names) | unique)' --argjson names "$(printf '%s\n' "${created[@]}" | jq -R . | jq -sc .)" || return 1
  fi
  fix_usr_local_owners || return 1
}
# Gives the shared /usr/local directories, and the Node.js files this installer put there, back to root. Earlier
# installers left them owned by the owner recorded in the Node.js archive (uid 1000, the soulstream account on a fresh
# server), which let that account replace the node, npm and corepack that root runs. Runs on every install and update,
# and prints only what it changed.
fix_usr_local_owners() {
  local expected=root:root rel path owner fixed=() node_installed
  [[ -e "$STAFF_MARKER" ]] && expected=root:staff
  for rel in $USR_LOCAL_DIRS; do
    path=$USR_LOCAL
    [[ "$rel" == . ]] || path=$USR_LOCAL/$rel
    [[ -d "$path" && ! -L "$path" ]] || continue
    owner=$(stat -c '%U:%G' -- "$path") || return 1
    [[ "$owner" == "$expected" ]] && continue
    chown -h "$expected" -- "$path" || return 1
    fixed+=("$path")
  done
  # Only a Node.js this installer unpacked; one that was already there is not ours to change.
  node_installed=$(jq -r '.node_tarball_installed' "$RECEIPT_FILE") || return 1
  if [[ "$node_installed" == true ]]; then
    for rel in $NODE_TARBALL_PATHS; do
      path=$USR_LOCAL/$rel
      [[ -e "$path" || -L "$path" ]] || continue
      owner=$(find "$path" \( ! -user root -o ! -group root \) -print -quit) || return 1
      [[ -n "$owner" ]] || continue
      chown -hR root:root -- "$path" || return 1
      fixed+=("$path")
    done
  fi
  if ((${#fixed[@]})); then
    printf 'Ownership under %s reset on: %s\n' "$USR_LOCAL" "${fixed[*]}"
    # run_step sends the line above to the install log only. fd 3 is the user's screen; a run without it skips this.
    { printf 'Ownership under %s reset on: %s\n' "$USR_LOCAL" "${fixed[*]}" >&3; } 2>/dev/null || true
  fi
  return 0
}
as_soul() { sudo -H -u soulstream env HOME=/home/soulstream PATH=/home/soulstream/.local/bin:/usr/local/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }
# Only a codex this run installs goes into the receipt; one already on the server stays out of it.
install_codex_global() {
  if ! as_soul bash -c 'command -v codex >/dev/null'; then
    npm install -g @openai/codex || return 1
    receipt_update '.codex_npm_global_installed = true' || return 1
  fi
}
install_clis() {
  if has_backend claude; then
    if ! as_soul bash -c 'command -v claude >/dev/null'; then as_soul bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash'; fi
    as_soul claude --version
  fi
  if has_backend codex; then
    install_codex_global || return 1
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
# The branch a repository follows when its ref is not given.
default_ref_for() {
  case $1 in
    soulstream) printf '%s' "$DEFAULT_SOULSTREAM_REF" ;;
    atom) printf '%s' "$DEFAULT_ATOM_REF" ;;
    *) printf 'No default revision for %s.\n' "$1" >&2; return 1 ;;
  esac
}
# Prints the commit that origin/<ref> points to. There is no fallback to main.
default_channel_target() {
  local dir=$1 ref=$2 target
  if ! target=$(as_soul git -C "$dir" rev-parse --verify --quiet "refs/remotes/origin/${ref}^{commit}"); then
    printf '%s: Cannot resolve revision origin/%s.\n' "$dir" "$ref" >&2; return 1
  fi
  printf '%s' "$target"
}
# A default-channel update never moves a checkout back to an older commit: a newer database ledger would stop the
# services in the schema step. An empty previous (a new clone) and the same commit pass.
check_not_behind() {
  local dir=$1 previous=$2 target=$3 ref=$4
  [[ -n "$previous" ]] || return 0
  if ! as_soul git -C "$dir" merge-base --is-ancestor "$previous" "$target"; then
    printf '%s: current HEAD %s is not an ancestor of origin/%s %s. Pass --ref main --atom-ref main to keep tracking main.\n' "$dir" "${previous:0:12}" "$ref" "${target:0:12}" >&2
    return 1
  fi
}
# The target revision's own install.sh is what the update expects, so the file that is running must be the same bytes.
# It is read here as root: the README command leaves it in a temporary file that only root can read.
check_installer_matches() {
  local dir=$1 target=$2 ref=$3
  if [[ -n "$RUNNING_INSTALLER" ]] && cmp -s "$RUNNING_INSTALLER" <(as_soul git -C "$dir" show "${target}:install/install.sh" 2>/dev/null); then return 0; fi
  printf 'The running installer is not install/install.sh of origin/%s. Download install.sh from https://raw.githubusercontent.com/eiaserinnys/soulstream/%s/install/install.sh and run it again, or pass --ref main --atom-ref main with the installer from main.\n' "$ref" "$ref" >&2
  return 1
}
# Without a ref the clone starts on the default branch. A clone left at the end of main by a run that failed before the
# services stopped would be ahead of the default branch, and the next run would refuse it.
clone_repository() {
  local url=$1 dir=$2 default_ref=$3
  if [[ -n "$default_ref" ]]; then as_soul git clone --branch "$default_ref" "$url" "$dir"; else as_soul git clone "$url" "$dir"; fi
}
# Records the previous and target commits of one repository before any service stops.
check_repository() {
  local name=$1 dir=$2 url=$3 ref=$4 ref_set=$5 previous= target mode branch= default_ref=
  if [[ "$ref_set" != true ]]; then default_ref=$(default_ref_for "$name") || return 1; fi
  if [[ -e "$dir" && ! -d "$dir/.git" ]]; then printf '%s: Exists and is not a git checkout.\n' "$dir" >&2; return 1; fi
  if [[ -d "$dir/.git" ]]; then
    previous=$(as_soul git -C "$dir" rev-parse HEAD) || return 1
    # Untracked files such as config/*.yaml and .env.orch are the installer's own.
    if [[ -n "$(as_soul git -C "$dir" status --porcelain --untracked-files=no)" ]]; then printf '%s: Repository has uncommitted changes.\n' "$dir" >&2; return 1; fi
    as_soul git -C "$dir" fetch --prune --tags origin || return 1
  elif ! clone_repository "$url" "$dir" "$default_ref"; then
    # The path did not exist before this run.
    rm -rf "$dir"
    return 1
  fi
  if [[ -n "$default_ref" ]]; then
    mode=branch; branch=$default_ref
    target=$(default_channel_target "$dir" "$default_ref") || return 1
  elif target=$(as_soul git -C "$dir" rev-parse --verify --quiet "refs/remotes/origin/${ref}^{commit}"); then
    mode=branch; branch=$ref
  elif target=$(as_soul git -C "$dir" rev-parse --verify --quiet "refs/tags/${ref}^{commit}") ||
       target=$(as_soul git -C "$dir" rev-parse --verify --quiet "${ref}^{commit}"); then
    mode=detach
  else
    printf '%s: Cannot resolve revision %s.\n' "$dir" "$ref" >&2; return 1
  fi
  # checkout -B would drop local commits on the branch it resets.
  if [[ -n "$branch" ]] && as_soul git -C "$dir" rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null &&
     ! as_soul git -C "$dir" merge-base --is-ancestor "refs/heads/${branch}" "$target"; then
    printf '%s: Local branch %s has commits that are not on origin.\n' "$dir" "$branch" >&2; return 1
  fi
  if [[ -n "$default_ref" ]]; then check_not_behind "$dir" "$previous" "$target" "$default_ref" || return 1; fi
  REPO_PATH[$name]=$dir; REPO_PREVIOUS[$name]=$previous; REPO_TARGET[$name]=$target; REPO_MODE[$name]=$mode; REPO_BRANCH[$name]=$branch
}
# Runs the two default-channel checks on existing checkouts before the first change to the server (packages, Node.js, CLIs).
# Only checkouts that follow the default channel are looked at; a given --ref or --atom-ref is the administrator's choice.
guard_existing_checkouts() {
  local root=$1 atom_root=$2 ref target previous
  if [[ "$REF_SET" != true ]]; then
    ref=$DEFAULT_SOULSTREAM_REF
    previous=$(as_soul git -C "$root" rev-parse HEAD) || return 1
    as_soul git -C "$root" fetch --prune --tags origin || return 1
    target=$(default_channel_target "$root" "$ref") || return 1
    check_not_behind "$root" "$previous" "$target" "$ref" || return 1
    check_installer_matches "$root" "$target" "$ref" || return 1
  fi
  if [[ "$ATOM_REF_SET" != true ]]; then
    ref=$DEFAULT_ATOM_REF
    previous=$(as_soul git -C "$atom_root" rev-parse HEAD) || return 1
    as_soul git -C "$atom_root" fetch --prune --tags origin || return 1
    target=$(default_channel_target "$atom_root" "$ref") || return 1
    check_not_behind "$atom_root" "$previous" "$target" "$ref" || return 1
  fi
}
# protect_atom_backup root: reads the state file of the previous run, before stop_services overwrites it. When that run did not
# complete and its atom dump still exists, the dump is the only copy from before the update's first migrate, so this run
# keeps it (init_atom takes no new one) and lists it in BACKUP_PATHS for the state file and the failure notice.
# A completed run, or a dump the administrator deleted, leaves nothing protected.
protect_atom_backup() {
  local state=$1/.local/install-state.json path
  PROTECTED_ATOM_BACKUP=
  [[ -f "$state" ]] || return 0
  path=$(jq -r 'if .status != "completed" then (.backups.atom.path // empty) else empty end' "$state") || { printf '%s: Cannot read the previous installation state.\n' "$state" >&2; return 1; }
  if [[ -n "$path" && -f "$path" ]]; then
    PROTECTED_ATOM_BACKUP=$path
    BACKUP_PATHS[atom]=$path
  fi
}
check_repositories() {
  local root=$1 atom_root=$2
  check_repository soulstream "$root" "$SOULSTREAM_REPO_URL" "$REF" "$REF_SET" || return 1
  # A first-stage installation passes when the target revision has atom support.
  if ! as_soul git -C "$root" cat-file -e "${REPO_TARGET[soulstream]}:install/seed/load_atom_seed.mjs" 2>/dev/null; then
    printf 'The selected Soulstream revision predates atom support.\n' >&2
    return 1
  fi
  if [[ "$REF_SET" != true ]]; then check_installer_matches "$root" "${REPO_TARGET[soulstream]}" "$DEFAULT_SOULSTREAM_REF" || return 1; fi
  check_repository atom "$atom_root" "$ATOM_REPO_URL" "$ATOM_REF" "$ATOM_REF_SET" || return 1
  protect_atom_backup "$root"
}

resolve_install_language() (
  local root=$1 scratch dir=install/seed/locales
  local -a args=("$root/config")
  if [[ -n "$REQUESTED_LANG" ]]; then args+=("$REQUESTED_LANG"); fi
  scratch=$(mktemp -d) || exit 1
  trap 'rm -rf -- "$scratch"' EXIT
  as_soul git -C "$root" archive "${REPO_TARGET[soulstream]}" \
    "$dir/installer-language.mjs" "$dir/languages.mjs" "$dir/languages.json" |
    tar -xf - -C "$scratch" || exit 1
  node "$scratch/$dir/installer-language.mjs" "${args[@]}"
)
# Prints one repository's entry for install-state.json; missing commits are null.
repo_state_json() {
  local name=$1 path=${REPO_PATH[$1]-} current=
  if [[ -n "$path" && -d "$path/.git" ]]; then current=$(as_soul git -C "$path" rev-parse HEAD 2>/dev/null) || current=; fi
  jq -n --arg path "$path" --arg previous "${REPO_PREVIOUS[$name]-}" --arg target "${REPO_TARGET[$name]-}" --arg current "$current" \
    'def sha: if . == "" then null else . end; {path: $path, previous_sha: ($previous | sha), target_sha: ($target | sha), current_sha: ($current | sha)}'
}
# The manual restore of one dump. The root shell opens the file, since postgres cannot read the backup directory.
restore_command() {
  printf "sudo -u postgres pg_restore --exit-on-error --no-owner --role=%s -d <empty_database> < '%s'" "$DATABASE_OWNER" "$1"
}
# Prints the backups object of install-state.json: each database dumped in this run, with its restore command.
backups_state_json() {
  local db json='{}'
  for db in soulstream atom; do
    [[ -n "${BACKUP_PATHS[$db]-}" ]] || continue
    json=$(jq -c --arg db "$db" --arg path "${BACKUP_PATHS[$db]}" --arg restore "$(restore_command "${BACKUP_PATHS[$db]}")" \
      '. + {($db): {path: $path, restore_command: $restore}}' <<< "$json") || return 1
  done
  printf '%s' "$json"
}
# write_install_state root status step [units-json]
write_install_state() {
  local root=$1 status=$2 step=$3 units=${4-} dir=$1/.local soulstream atom backups temp
  if [[ ! -d "$dir" ]]; then
    { mkdir -p "$dir" && chown soulstream:soulstream "$dir"; } || return 1
  fi
  soulstream=$(repo_state_json soulstream) || return 1
  atom=$(repo_state_json atom) || return 1
  backups=$(backups_state_json) || return 1
  temp=$(mktemp "$dir/install-state.json.XXXXXX") || return 1
  if ! jq -n --arg status "$status" --arg step "$step" --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson soulstream "$soulstream" --argjson atom "$atom" --argjson backups "$backups" --arg units "$units" \
      '{status: $status, step: $step, updated_at: $updated_at, repositories: {soulstream: $soulstream, atom: $atom}, backups: $backups}
        + (if $units == "" then {} else {units: ($units | fromjson)} end)' > "$temp" ||
     ! chmod 600 "$temp" || ! mv "$temp" "$dir/install-state.json"; then
    rm -f "$temp"; return 1
  fi
}
stop_services() {
  local root=$1 unit
  MAINTENANCE_ENTERED=true
  for unit in $SERVICE_UNITS; do
    if [[ -e "$SYSTEMD_DIR/$unit" ]]; then systemctl stop "$unit" || return 1; fi
  done
  write_install_state "$root" updating "$STEP" || return 1
}
checkout_repository() {
  local name=$1 dir=${REPO_PATH[$1]} target=${REPO_TARGET[$1]} branch=${REPO_BRANCH[$1]} head
  case "${REPO_MODE[$name]}" in
    branch) as_soul git -C "$dir" checkout -B "$branch" "origin/$branch" || return 1 ;;
    detach) as_soul git -C "$dir" checkout --detach "$target" || return 1 ;;
  esac
  head=$(as_soul git -C "$dir" rev-parse HEAD) || return 1
  if [[ "$head" != "$target" ]]; then printf '%s: HEAD is %s, expected %s.\n' "$dir" "$head" "$target" >&2; return 1; fi
}
checkout_revisions() {
  checkout_repository soulstream || return 1
  checkout_repository atom || return 1
}
# Uses DB_PASSWORD from setup_secrets. The role SQL goes through stdin and psql output is discarded.
setup_database() {
  local name
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='soulstream'" | grep -qx 1; then
    if ! printf "CREATE ROLE soulstream LOGIN PASSWORD '%s';\n" "$DB_PASSWORD" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 >/dev/null 2>/dev/null; then printf 'Failed to create PostgreSQL role soulstream.\n' >>"$LOG"; return 1; fi
  else
    # A rerun after a failure between here and Writing configuration has a new DB_PASSWORD; both env files are rewritten in this run.
    if ! printf "ALTER ROLE soulstream LOGIN PASSWORD '%s';\n" "$DB_PASSWORD" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 >/dev/null 2>/dev/null; then printf 'Failed to update PostgreSQL role soulstream.\n' >>"$LOG"; return 1; fi
  fi
  for name in soulstream atom; do
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${name}'" | grep -qx 1; then sudo -u postgres createdb -O soulstream "$name"; fi
  done
}
# backup_database root db: dumps the local database db to <root>/.local/backups/<db>-<UTC>-<previous12>-to-<target12>.pgdump.
# The commits are those of the repository with the same name. postgres writes to stdout and this root shell opens the file;
# peer authentication over the local socket, so no password reaches argv or the environment.
# The file is named and the oldest dumps beyond BACKUP_KEEP removed only after pg_restore reads it back.
backup_database() {
  local root=$1 db=$2 dir=$1/.local/backups previous=${REPO_PREVIOUS[$2]-} target=${REPO_TARGET[$2]-} temp final i
  local -a dumps
  previous=${previous:0:12}
  [[ -n "$previous" ]] || previous=none
  { mkdir -p "$dir" && chmod 700 "$dir" && chown soulstream:soulstream "$dir"; } || return 1
  temp=$(mktemp "$dir/.$db.XXXXXX") || return 1
  if ! { chmod 600 "$temp" && sudo -u postgres pg_dump --format=custom --no-password -d "$db" > "$temp" && pg_restore --list "$temp" > /dev/null; }; then
    rm -f "$temp"
    printf 'Backup of database %s failed.\n' "$db" >&2
    return 1
  fi
  # A dump of the same database within the same second waits instead of replacing it.
  while final=$dir/$db-$(date -u +%Y%m%dT%H%M%SZ)-$previous-to-${target:0:12}.pgdump; [[ -e "$final" ]]; do sleep 1; done
  if ! { chown soulstream:soulstream "$temp" && mv "$temp" "$final"; }; then rm -f "$temp"; return 1; fi
  BACKUP_PATHS[$db]=$final
  printf 'Database backup (%s): %s\n' "$db" "$final"
  dumps=("$dir/$db"-????????T??????Z-*.pgdump)
  for ((i = 0; i < ${#dumps[@]} - BACKUP_KEEP; i++)); do rm -f -- "${dumps[i]}" || return 1; done
}
build_atom() {
  local atom_root=$1
  as_soul env NODE_ENV=development npm --prefix "$atom_root" ci --include=dev
  as_soul npm --prefix "$atom_root" run build
  # corepack picks the project from the working directory.
  as_soul bash -ec 'cd "$1/dashboard"; corepack pnpm install --frozen-lockfile --prod=false; corepack pnpm run build' bash "$atom_root"
}
# Uses INSTALL_ROOT for the backup directory.
init_atom() {
  local atom_root=$1 fresh default_frontend=http://127.0.0.1:4200 frontend populated
  if [[ "${TAILSCALE:-false}" == true ]]; then default_frontend=https://${TAILSCALE_DNS}:8443; fi
  frontend=$(pick_address "${ATOM_PUBLIC_URL_OPT:-}" "${INSTALL_ROOT:-}" "$atom_root/.env" FRONTEND_URL "$default_frontend") || return 1
  fresh=$(mktemp) || return 1
  register_temp_file "$fresh"
  if ! {
    cat > "$fresh" <<ENV &&
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4200
DATABASE_URL=postgresql://soulstream:${DB_PASSWORD}@127.0.0.1:5432/atom
JWT_SECRET=${ATOM_JWT_SECRET}
DASHBOARD_DIR=${atom_root}/dashboard/dist
FRONTEND_URL=${frontend}
ENV
    printf 'DASHBOARD_ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >> "$fresh" &&
    merge_env "$atom_root/.env" "$fresh" 'NODE_ENV API_HOST API_PORT DATABASE_URL JWT_SECRET DASHBOARD_ADMIN_PASSWORD DASHBOARD_DIR FRONTEND_URL'
  }; then
    rm -f "$fresh"
    return 1
  fi
  rm -f "$fresh"
  chown soulstream:soulstream "$atom_root/.env" || return 1
  # A non-empty atom database is dumped before every migrate, the same revision included; the .env above names this database.
  # Not when this run retries a failed update: the database is already migrated, and the dump of that update's first run must stay.
  if [[ -n "$PROTECTED_ATOM_BACKUP" ]]; then
    printf 'Keeping the first atom backup of this update: %s\n' "$PROTECTED_ATOM_BACKUP"
  else
    populated=$(sudo -u postgres psql -d atom -tA -v ON_ERROR_STOP=1 <<< "SELECT to_regclass('public.cards') IS NOT NULL;") || return 1
    if [[ "$populated" == t ]]; then
      backup_database "$INSTALL_ROOT" atom || return 1
      # A crash inside migrate leaves the state file of the previous step, which would not name this dump.
      if [[ "$MAINTENANCE_ENTERED" == true ]]; then write_install_state "$INSTALL_ROOT" updating "$STEP" || return 1; fi
    fi
  fi
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
  write_atom_unit "$SYSTEMD_DIR" "$atom_root"
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
  output=$(as_soul node "$root/install/seed/load_atom_seed.mjs" --atom-url "$ATOM_URL" --password-file "$root/.admin-password" --state-dir "$root/config" --lang "$INSTALL_LANG") || status=$?
  if [[ -n "$output" ]]; then printf '%s\n' "$output"; fi
  while IFS= read -r line; do
    if [[ "$line" == 'WARNING: '* ]]; then ATOM_SEED_WARNINGS+="${line#WARNING: }"$'\n'; fi
  done <<< "$output"
  return "$status"
}
write_configuration() {
  local home=$1 root=$2
  render_config "$home" "$root" || return 1
  chown -R soulstream:soulstream "$root/config" "$root/.env.orch" "$root/.env.soul-server-ts" "$root/.local" "$home/workspace"
}
build_project() {
  local root=$1
  as_soul bash -ec 'cd "$1"; corepack pnpm install --frozen-lockfile --prod=false; SOULSTREAM_RELEASE_ENV_FILE="$1/.env.soul-server-ts" corepack pnpm --filter @soulstream/soul-server-ts run build; corepack pnpm --filter @soulstream/orch-server-ts run build; corepack pnpm --dir "$1/unified-dashboard" run build' bash "$root"
}
# release_phase root head phase: runs one database release phase as soulstream under the installer authority.
# Every phase of a run gets the same identity from head. The JSON results go to the log and the last stdout line
# stays in RELEASE_RESULT; a failure adds its error code.
release_phase() {
  local root=$1 head=$2 phase=$3 err status=0 code
  err=$(mktemp) || return 1
  RELEASE_RESULT=$(as_soul bash -ec 'cd "$1"; release=clean-${2:0:12}
export HANIEL_SERVICE_ENV_FILE="$1/.env.orch" HANIEL_TARGET_HEAD="$2" HANIEL_PREVIOUS_HEAD="$2" HANIEL_RELEASE_ID="$release" SOULSTREAM_RELEASE_ID="$release" HANIEL_REQUEST_ID="installer-$2" HANIEL_DEPLOY_REPO=soulstream HANIEL_BACKUP_DIR="$1/.local/database-release/$release"
exec node packages/db-schema/scripts/release-executor.mjs "$3" --manifest install/release-manifest-installer.json --database-contract install/database-release-installer.json' bash "$root" "$head" "$phase" 2> "$err") || status=$?
  printf '%s\n' "$RELEASE_RESULT"
  cat "$err" >&2
  if ((status != 0)); then
    code=$(jq -Rr 'fromjson? | .error.code? // empty' < "$err" | tail -n 1) || code=
    printf 'Database release %s failed: %s\n' "$phase" "${code:-no error code}" >&2
  fi
  rm -f "$err"
  RELEASE_RESULT=$(tail -n 1 <<< "$RELEASE_RESULT")
  return "$status"
}
setup_schema() {
  local root=$1 head fields operation status pending additive
  head=$(as_soul git -C "$root" rev-parse HEAD) || return 1
  release_phase "$root" "$head" preflight || return 1
  if ! fields=$(jq -er 'select(.ok == true and (.operation | type) == "string" and (.status | type) == "string"
      and (.pending_count | type) == "number" and (.pending_additive_only | type) == "boolean")
      | "\(.operation) \(.status) \(.pending_count) \(.pending_additive_only)"' <<< "$RELEASE_RESULT"); then
    printf 'Database release preflight returned an unexpected result.\n' >&2
    return 1
  fi
  read -r operation status pending additive <<< "$fields"
  # Only a journal that has not committed yet takes a dump. verified and applied_reconciled journals still report
  # their first plan's count, so a same-target rerun would otherwise push the pre-change dump out of the newest three.
  if [[ "$operation" == upgrade && "$additive" == false && " preflight_complete apply_started apply_failed " == *" $status "* ]] &&
     ((pending > 0)); then
    backup_database "$root" soulstream || return 1
  fi
  release_phase "$root" "$head" apply || return 1
  release_phase "$root" "$head" verify || return 1
  # The executor verify returns at once on a verified journal; this reads the ledger and the schema again.
  as_soul bash -ec 'cd "$1"; export HANIEL_SERVICE_ENV_FILE="$1/.env.orch" SOULSTREAM_RELEASE_ID="clean-${2:0:12}"; node packages/db-schema/scripts/migrate.mjs verify' bash "$root" "$head" || return 1
  local owner=owner@local display_name=Owner
  if [[ "$TAILSCALE" == true ]]; then owner=$TAILSCALE_USER; display_name=$owner; fi
  sudo -u postgres psql -d soulstream -v ON_ERROR_STOP=1 -v "owner=$owner" -v "display_name=$display_name" >/dev/null <<'SQL'
INSERT INTO users (email, display_name, is_admin) VALUES (:'owner', :'display_name', TRUE) ON CONFLICT (email) DO NOTHING;
SQL
}
install_units() {
  local root=$1
  cat > "$SYSTEMD_DIR/soulstream-orch.service" <<UNIT
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
  # 워커 유닛의 KillMode=process: 서버를 재시작해도 detached 세션 러너와 그 agy가 살아 새 서버가 이어받게 하려는 것이다.
  # 서버가 직접 띄운 자식(사용량 조회 agy, 로그인 CLI)은 서버가 종료 때 거둔다.
  cat > "$SYSTEMD_DIR/soulstream-worker.service" <<UNIT
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
# Registers the paused daily review job once. The server returns the existing job for a repeated key, so a reinstall
# never overwrites what the user switched on or edited. A refusal (for example no signed-in backend yet) only warns:
# the job can be created later from the recurring jobs tab.
register_daily_review_job() {
  local workspace_folder=$1
  shift
  local folder_id body status
  folder_id=$(curl -fsS "$@" http://127.0.0.1:5200/api/folders | jq -r --arg name "$workspace_folder" '[.folders[] | select(.name==$name)][0].id') || return 1
  body=$(jq --arg folder "$folder_id" '{idempotencyKey: "clean-install-daily-review", name: .dailyReview.name, prompt: .dailyReview.prompt, timezone: "UTC", scheduleExpressions: ["0 9 * * *"], nodeId: "local", agentId: "seosoyoung", modelPreset: null, folderId: $folder, enabled: false}' "$(installer_text_path)") || return 1
  status=$(curl -s -o /dev/null -w '%{http_code}' "$@" -X POST -H 'Content-Type: application/json' --data "$body" http://127.0.0.1:5200/api/recurring-jobs)
  if [[ "$status" != 200 && "$status" != 201 ]]; then
    printf 'Could not register the daily review recurring job (HTTP %s). Create it later in the recurring jobs settings tab.\n' "$status" >&2
  fi
  return 0
}
wait_and_create_workspace() {
  local root=$1 header cookie deadline status count worker_port workspace_folder workspace_body
  workspace_folder=$(jq -er '.workspaceFolder' "$(installer_text_path)") || return 1
  workspace_body=$(jq -n --arg name "$workspace_folder" '{name: $name, idempotencyKey: "clean-install-default-workspace"}') || return 1
  worker_port=$(read_env_value "$root/.env.soul-server-ts" PORT) || return 1
  header=$(mktemp) || return 1
  register_temp_file "$header"
  cookie=$(mktemp) || return 1
  register_temp_file "$cookie"
  chmod 600 "$header" "$cookie" || return 1
  printf 'Authorization: Bearer %s\n' "$(read_env_value "$root/.env.orch" AUTH_BEARER_TOKEN)" > "$header"
  deadline=$((SECONDS+120))
  until curl --max-time 3 -fsS http://127.0.0.1:5200/api/health >/dev/null 2>&1 && curl --max-time 3 -fsS http://127.0.0.1:${worker_port}/health >/dev/null 2>&1 && curl --max-time 3 -fsS -H "@$header" http://127.0.0.1:5200/api/nodes 2>/dev/null | jq -e '.nodes[] | select(.nodeId=="local" and .connected==true)' >/dev/null; do
    if ((SECONDS >= deadline)); then journalctl -u soulstream-orch.service -n 50 --no-pager; journalctl -u soulstream-worker.service -n 50 --no-pager; rm -f "$header" "$cookie"; return 1; fi
    sleep 2
  done
  if [[ "$TAILSCALE" == true ]]; then
    printf 'Tailscale-User-Login: %s\n' "$TAILSCALE_USER" > "$cookie"
    count=$(curl -fsS -H "@$cookie" http://127.0.0.1:5200/api/folders | jq --arg name "$workspace_folder" '[.folders[] | select(.name==$name)] | length')
    if [[ "$count" == 0 ]]; then
      curl -fsS -H "@$cookie" -X POST -H 'Content-Type: application/json' --data "$workspace_body" http://127.0.0.1:5200/api/folders >/dev/null
    fi
    curl -fsS -H "@$cookie" http://127.0.0.1:5200/api/folders | jq -e --arg name "$workspace_folder" '[.folders[] | select(.name==$name)] | length == 1' >/dev/null
    register_daily_review_job "$workspace_folder" -H "@$cookie" || { rm -f "$header" "$cookie"; return 1; }
    status=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5200/api/folders)
    [[ "$status" == 401 ]]
    status=$(curl -s -o /dev/null -w '%{http_code}' -H "@$cookie" -H 'Tailscale-Funnel-Request: ?1' http://127.0.0.1:5200/api/folders)
    [[ "$status" == 401 ]]
    status=$(curl -s -o /dev/null -w '%{http_code}' -H "Tailscale-User-Login: ${TAILSCALE_USER}.other" http://127.0.0.1:5200/api/folders)
    [[ "$status" == 401 || "$status" == 403 ]]
    rm -f "$header" "$cookie"
    return 0
  fi
  # jq builds the JSON, so any password the value rule allows (spaces, $, !) reaches the login as is. The
  # subshell sets pipefail so a failed jq stops the login instead of posting an empty body.
  if ! ( set -o pipefail; jq -Rs '{password: (rtrimstr("\n") | rtrimstr("\r"))}' < "$root/.admin-password" |
      curl -fsS -c "$cookie" -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:5200/api/auth/password-login >/dev/null ); then
    rm -f "$header" "$cookie"
    return 1
  fi
  count=$(curl -fsS -b "$cookie" http://127.0.0.1:5200/api/folders | jq --arg name "$workspace_folder" '[.folders[] | select(.name==$name)] | length')
  if [[ "$count" == 0 ]]; then
    curl -fsS -b "$cookie" -X POST -H 'Content-Type: application/json' --data "$workspace_body" http://127.0.0.1:5200/api/folders >/dev/null
  fi
  curl -fsS -b "$cookie" http://127.0.0.1:5200/api/folders | jq -e --arg name "$workspace_folder" '[.folders[] | select(.name==$name)] | length == 1' >/dev/null
  register_daily_review_job "$workspace_folder" -b "$cookie" || { rm -f "$header" "$cookie"; return 1; }
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
        ["claude", "codex", "opencode_go"] as $names |
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
revision_line() {
  local label=$1 name=$2 previous=${REPO_PREVIOUS[$2]-} current=none
  if [[ -z "$previous" ]]; then previous=none; fi
  if [[ -n "${REPO_PATH[$name]-}" ]]; then current=$(as_soul git -C "${REPO_PATH[$name]}" rev-parse --short=12 HEAD); fi
  printf '%s revision: %s -> %s\n' "$label" "${previous:0:12}" "$current"
}
# The local end of the SSH tunnel: the port of a loopback address, else the server's own port.
tunnel_local_port() {
  if [[ "$1" =~ ^http://(127\.0\.0\.1|localhost):([0-9]+)$ ]]; then printf '%s' "${BASH_REMATCH[2]}"; else printf '%s' "$2"; fi
}
finish_message() {
  local root=$1 line
  printf '\nInstalled %s; backends: %s\n' "$(as_soul git -C "$root" rev-parse --short=12 HEAD)" "$BACKENDS"
  revision_line Soulstream soulstream
  revision_line Atom atom
  # A password generated at a terminal goes to /dev/tty only; stdout and the install log never carry it.
  local tty_shown=false
  if [[ "${PASSWORD_SOURCE:-}" == generated_tty && -n "${ADMIN_PASSWORD:-}" ]] && { exec 4>/dev/tty; } 2>/dev/null; then
    tty_shown=true
  fi
  if [[ "$TAILSCALE" == true ]]; then
    printf 'Open https://%s from a tailnet device signed in as %s.\n' "$TAILSCALE_DNS" "$TAILSCALE_USER"
    printf 'Local processes on this server can forge identity headers.\n'
    printf 'Remove access: tailscale serve reset && tailscale logout\n'
    case "${PASSWORD_SOURCE:-}" in
      user_tty|file)
        printf 'Atom: https://%s:8443 (use the administrator password you set; saved in %s/.admin-password)\n' "$TAILSCALE_DNS" "$root" ;;
      generated_tty)
        if [[ "$tty_shown" == true ]]; then
          printf 'Atom: https://%s:8443 (generated password shown on your terminal; saved in %s/.admin-password)\n' "$TAILSCALE_DNS" "$root"
        else
          printf 'Atom: https://%s:8443 (password: sudo cat %s/.admin-password)\n' "$TAILSCALE_DNS" "$root"
        fi ;;
      *)
        printf 'Atom: https://%s:8443 (password: sudo cat %s/.admin-password)\n' "$TAILSCALE_DNS" "$root" ;;
    esac
  else
    local dashboard_url atom_url
    dashboard_url=$(read_env_value "$root/.env.orch" SOULSTREAM_PUBLIC_URL) || dashboard_url=
    atom_url=$(read_env_value "$root/.env.orch" ATOM_PUBLIC_URL) || atom_url=
    dashboard_url=${dashboard_url:-http://127.0.0.1:5200}
    atom_url=${atom_url:-http://127.0.0.1:4200}
    printf 'Connect: ssh -L 127.0.0.1:%s:127.0.0.1:5200 -L 127.0.0.1:%s:127.0.0.1:4200 <user>@<server>\n' "$(tunnel_local_port "$dashboard_url" 5200)" "$(tunnel_local_port "$atom_url" 4200)"
    printf 'Soulstream: %s\n' "$dashboard_url"
    printf 'Atom: %s\n' "$atom_url"
    case "${PASSWORD_SOURCE:-}" in
      user_tty|file)
        printf 'Password for both: use the administrator password you set (saved in %s/.admin-password)\n' "$root" ;;
      generated_tty)
        if [[ "$tty_shown" == true ]]; then
          printf 'Password for both: shown on your terminal (saved in %s/.admin-password)\n' "$root"
        else
          printf 'Password for both: sudo cat %s/.admin-password\n' "$root"
        fi ;;
      *)
        printf 'Password for both: sudo cat %s/.admin-password\n' "$root" ;;
    esac
  fi
  if [[ "$tty_shown" == true ]]; then
    printf 'Generated administrator password (for Soulstream and atom): %s\n' "$ADMIN_PASSWORD" >&4
    exec 4>&-
  fi
  local pas_name coding_agents_path
  pas_name=$(jq -er '.profiles."seosoyoung-pas"' "$(installer_text_path)") || return 1
  coding_agents_path=$(jq -er '.codingAgentsPath' "$(installer_text_path)") || return 1
  printf 'PAS: once you connect a coding agent, the dashboard creates a default %s persistent session.\n' "$pas_name"
  if [[ -n "${ATOM_SEED_WARNINGS:-}" ]]; then
    printf 'Atom instructions:\n'
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then printf '  %s\n' "$line"; fi
    done <<< "$ATOM_SEED_WARNINGS"
  fi
  if [[ -n "${MANAGED_CONFIG_WARNINGS:-}" ]]; then
    printf 'Configuration:\n'
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then printf '  %s\n' "$line"; fi
    done <<< "$MANAGED_CONFIG_WARNINGS"
  fi
  if has_backend antigravity; then
    printf 'Login: connect Claude, Codex, and Antigravity in the dashboard under %s.\n' "$coding_agents_path"
    printf "Antigravity stays off until you turn it on under %s and accept Google's terms.\n" "$coding_agents_path"
    printf 'SSH alternative: Codex with "sudo -Hu soulstream /usr/local/bin/codex login --device-auth" (enable device code login in ChatGPT security settings), Antigravity by running ~/.local/bin/agy as the soulstream user.\n'
  else
    printf 'Login: connect Claude and Codex in the dashboard under %s.\n' "$coding_agents_path"
    if has_backend codex; then printf 'SSH alternative: Codex with "sudo -Hu soulstream /usr/local/bin/codex login --device-auth" (enable device code login in ChatGPT security settings).\n'; fi
  fi
  printf 'After login, presets update within five minutes. To refresh now as root:\n'
  printf '%s\n' "awk -F= '/^AUTH_BEARER_TOKEN=/{print \"Authorization: Bearer \" substr(\$0,index(\$0,\"=\")+1)}' $root/.env.orch | curl -fsS -X POST -H @- http://127.0.0.1:5200/api/usage/refresh"
  if [[ "${PRESET_REFRESH_PENDING:-false}" == true ]]; then printf 'Model preset status is not confirmed yet; it updates within five minutes.\n'; fi
  return 0
}
on_error() {
  trap - ERR
  printf '\nInstallation failed at: %s\nLog: %s\n' "$STEP" "$LOG" >&3
  tail -n 30 "$LOG" >&3
  # A generated password is saved before anything can fail after it, but it is shown only at the very end.
  if [[ "${GENERATED_PASSWORD_SAVED:-false}" == true && -n "${INSTALL_ROOT:-}" && -f "$INSTALL_ROOT/.admin-password" ]]; then
    printf 'Administrator password saved (0600, owned by soulstream): sudo cat %s/.admin-password\n' "$INSTALL_ROOT" >&3
  fi
  if [[ "$MAINTENANCE_ENTERED" == true ]]; then
    local unit state units='{}' summary= db
    # Leave no service partly started.
    for unit in $SERVICE_UNITS; do
      if [[ -e "$SYSTEMD_DIR/$unit" ]]; then systemctl stop "$unit" >> "$LOG" 2>&1 || true; fi
    done
    for unit in $SERVICE_UNITS; do
      state=absent
      if [[ -e "$SYSTEMD_DIR/$unit" ]]; then state=$(systemctl is-active "$unit" 2>/dev/null) || true; fi
      summary+=" ${unit%.service}=${state}"
      units=$(jq -c --arg unit "$unit" --arg state "$state" '. + {($unit): $state}' <<< "$units" 2>/dev/null) || true
    done
    write_install_state "$INSTALL_ROOT" failed "$STEP" "$units" >> "$LOG" 2>&1 || true
    printf 'Services stopped:%s\nState: %s/.local/install-state.json\n' "$summary" "$INSTALL_ROOT" >&3
    for db in soulstream atom; do
      [[ -n "${BACKUP_PATHS[$db]-}" ]] || continue
      printf 'Database backup (%s): %s\n' "$db" "${BACKUP_PATHS[$db]}" >&3
      printf 'Restore it only to give up the new revision: with the services stopped and a compatible revision checked out, as root restore into an empty database: %s\n' "$(restore_command "${BACKUP_PATHS[$db]}")" >&3
    done
    printf 'Fix the cause, then run the same command again.\n' >&3
  fi
  exit 1
}
run_step() {
  STEP=$1; shift
  printf '%s\n' "$STEP"
  if [[ "$MAINTENANCE_ENTERED" == true ]]; then write_install_state "$INSTALL_ROOT" updating "$STEP" >> "$LOG" 2>&1; fi
  "$@" >> "$LOG" 2>&1
}
# Fixed before prepare_install_cwd changes the directory, so a relative path such as install/install.sh still finds the file.
pin_running_installer() { RUNNING_INSTALLER=$(realpath -- "${BASH_SOURCE[0]}" 2>/dev/null) || RUNNING_INSTALLER=; }
prepare_install_cwd() { cd /; }
# Everything that changes the server; services stop only after both repositories are checked.
run_install() {
  disable_xtrace
  local home=$1 root=$2 atom_root=$3
  INSTALL_ROOT=$root
  # An existing server is checked against the default channel before anything on it changes, not only before the services stop.
  if [[ -d "$root/.git" && -d "$atom_root/.git" ]]; then
    STEP='Checking repositories'
    guard_existing_checkouts "$root" "$atom_root" >> "$LOG" 2>&1
  fi
  run_step 'Installing packages' install_packages
  if [[ "$TAILSCALE" == true ]]; then STEP='Setting up Tailscale'; printf '%s\n' "$STEP"; setup_tailscale; fi
  run_step 'Setting up account' setup_account
  run_step 'Installing Node.js' install_node
  run_step 'Installing selected CLIs' install_clis
  run_step 'Checking repositories' check_repositories "$root" "$atom_root"
  STEP='Choosing installation language'
  INSTALL_LANG=$(resolve_install_language "$root")
  run_step 'Stopping services' stop_services "$root"
  run_step 'Checking out revisions' checkout_revisions
  INSTALL_SOURCE=$root/install
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
  write_install_state "$root" completed "$STEP" >> "$LOG" 2>&1
  MAINTENANCE_ENTERED=false
  run_step 'Checking model presets' refresh_model_presets "$root"
  finish_message "$root"
}
main() {
  disable_xtrace
  # The caller's umask may be 077; the soulstream account must still be able to read and run what root installs.
  umask 022
  set -Eeuo pipefail
  trap 'restore_tty_echo; cleanup_temp_files' EXIT
  parse_args "$@"
  pin_running_installer
  prepare_install_cwd
  preflight
  # Asked before packages are installed or services stop, so a rejected value changes nothing on the server.
  resolve_admin_password /home/soulstream/soulstream /home/soulstream/atom
  exec 3>&2
  LOG=/var/log/soulstream-install.log; STEP=setup
  touch "$LOG"; chmod 600 "$LOG"; trap on_error ERR
  run_install /home/soulstream /home/soulstream/soulstream /home/soulstream/atom
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
