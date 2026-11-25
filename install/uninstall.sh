#!/usr/bin/env bash
# Removes a Soulstream and atom installation made by install.sh on a dedicated Linux server.
#
# Two kinds of things are removed:
#   1. Resources only this product uses are removed by name: the soulstream user and /home/soulstream, the
#      soulstream and atom databases and the soulstream role, the three systemd units, the install log, and
#      the Tailscale Serve root routes that proxy to 127.0.0.1:5200 and 127.0.0.1:4200.
#   2. Shared /usr/local tools (Node.js, the Corepack shims, @openai/codex) are removed only when
#      /etc/soulstream/install-receipt.json says install.sh added them.
#
# Usage: uninstall.sh [--yes] [--help]

ACCOUNT=soulstream
SERVICE_UNITS='soulstream-worker.service soulstream-orch.service soulstream-atom.service'
DATABASES='soulstream atom'
DB_ROLE=soulstream
# Tailscale Serve roots this product creates: HTTPS port and the proxy it points to.
SERVE_ROUTES=('443|http://127.0.0.1:5200' '8443|http://127.0.0.1:4200')
COREPACK_SHIMS='pnpm pnpx yarn yarnpkg'
# Debian's base-files makes the shared /usr/local directories root:staff when this file exists, root:root otherwise. Tests reassign it.
STAFF_MARKER=/etc/staff-group-for-usr-local
# Shared /usr/local directories (relative to the /usr/local dir, . is the dir itself) whose owner is reset; install.sh keeps the same list.
USR_LOCAL_DIRS='. bin lib include share share/man share/man/man1 share/doc lib/node_modules'
NODE_BUNDLE='bin/npm bin/npx bin/corepack lib/node_modules/npm lib/node_modules/corepack include/node share/doc/node share/man/man1/node.1 CHANGELOG.md LICENSE README.md'

usage() {
  printf 'Usage: uninstall.sh [--yes] [--help]\n'
}

parse_args() {
  ASSUME_YES=false
  while (($#)); do
    case "$1" in
      --yes) ASSUME_YES=true ;;
      --help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
}

has_cmd() { command -v "$1" >/dev/null 2>&1; }
exists_or_link() { [[ -e "$1" || -L "$1" ]]; }
trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}
note_removed() { REMOVED+=("$1"); }
note_kept() { KEPT+=("$1"); }
note_failed() { FAILURES+=("$1"); }

# Refuses anything that is not a specific absolute path below the system directories.
safe_rm_tree() {
  local path=$1
  case "$path" in /*) ;; *) return 1 ;; esac
  case "$path/" in */../*|*/./*) return 1 ;; esac
  while [[ "$path" == */ ]]; do path=${path%/}; done
  case "$path" in
    ''|/|/bin|/boot|/dev|/etc|/etc/systemd|/etc/systemd/system|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/bin|/usr/lib|/usr/local|/usr/local/bin|/usr/local/include|/usr/local/lib|/usr/local/share|/usr/sbin|/usr/share|/var|/var/log)
      return 1 ;;
  esac
  rm -rf -- "$path"
}

pg() { sudo -u postgres psql -X -Atq -v ON_ERROR_STOP=1 "$@"; }

# Fills SERVE_JSON with the current Tailscale Serve configuration.
serve_query() {
  local out
  out=$(tailscale serve status --json 2>/dev/null) || return 1
  # tailscale prints null instead of {} when nothing is served (never used, or after tailscale logout).
  jq -e 'type == "object" or type == "null"' <<< "$out" >/dev/null 2>&1 || return 1
  SERVE_JSON=$out
}
# serve_matches <json> <port> <proxy>: the hosts whose root route on that port proxies to <proxy>.
serve_matches() {
  jq -r --arg suffix ":$2" --arg proxy "$3" \
    '(.Web // {}) | to_entries[] | select(.key | endswith($suffix)) | select((((.value.Handlers // {})["/"] // {}).Proxy // "") == $proxy) | .key' <<< "$1"
}

# Sets RECEIPT_STATE to absent, invalid or valid and, when valid, the R_* fields.
read_receipt() {
  RECEIPT_STATE=absent
  R_NODE=false; R_NODE_VERSION=; R_SHIMS=(); R_CODEX=false
  exists_or_link "$UN_RECEIPT" || return 0
  RECEIPT_STATE=invalid
  [[ -f "$UN_RECEIPT" && ! -L "$UN_RECEIPT" && -r "$UN_RECEIPT" ]] || return 0
  has_cmd jq || return 0
  [[ "$(jq '.schema == 1
    and (.node_tarball_installed | type == "boolean")
    and (.codex_npm_global_installed | type == "boolean")
    and (.corepack_shims_created | type == "array" and all(.[]; IN("pnpm", "pnpx", "yarn", "yarnpkg")))
    and (if .node_tarball_installed then (.node_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$")) else true end)' \
    "$UN_RECEIPT" 2>/dev/null)" == true ]] || return 0
  R_NODE=$(jq -r '.node_tarball_installed' "$UN_RECEIPT") || return 0
  R_NODE_VERSION=$(jq -r '.node_version // ""' "$UN_RECEIPT") || return 0
  R_CODEX=$(jq -r '.codex_npm_global_installed' "$UN_RECEIPT") || return 0
  mapfile -t R_SHIMS < <(jq -r '.corepack_shims_created[]' "$UN_RECEIPT") || return 0
  RECEIPT_STATE=valid
}

# Looks at the server and fills the FOUND_* lists; a query that fails counts in SCAN_ERRORS.
scan_server() {
  local unit db route port proxy out
  SCAN_ERRORS=0
  FOUND_UNITS=(); FOUND_SERVE=(); FOUND_DBS=(); FOUND_ROLE=false
  FOUND_ACCOUNT=false; FOUND_HOME=false; FOUND_LOG=false; FOUND_RECEIPT=false; FOUND_USRLOCAL=()
  for unit in $SERVICE_UNITS; do
    if exists_or_link "$UN_SYSTEMD/$unit" || [[ -L "$UN_SYSTEMD/multi-user.target.wants/$unit" ]]; then FOUND_UNITS+=("$unit"); fi
  done
  if has_cmd tailscale; then
    if serve_query; then
      for route in "${SERVE_ROUTES[@]}"; do
        port=${route%%|*}; proxy=${route#*|}
        if [[ -n "$(serve_matches "$SERVE_JSON" "$port" "$proxy")" ]]; then FOUND_SERVE+=("$port|$proxy"); fi
      done
    else
      SCAN_ERRORS=$((SCAN_ERRORS + 1))
    fi
  fi
  if has_cmd psql; then
    if out=$(pg -c "SELECT datname FROM pg_database WHERE datname IN ('soulstream', 'atom')" 2>/dev/null); then
      for db in $DATABASES; do
        if grep -qx "$db" <<< "$out"; then FOUND_DBS+=("$db"); fi
      done
      if out=$(pg -c "SELECT rolname FROM pg_roles WHERE rolname = '$DB_ROLE'" 2>/dev/null); then
        if grep -qx "$DB_ROLE" <<< "$out"; then FOUND_ROLE=true; fi
      else
        SCAN_ERRORS=$((SCAN_ERRORS + 1))
      fi
    else
      SCAN_ERRORS=$((SCAN_ERRORS + 1))
    fi
  fi
  if id -u "$ACCOUNT" >/dev/null 2>&1 || getent passwd "$ACCOUNT" >/dev/null 2>&1; then FOUND_ACCOUNT=true; fi
  if exists_or_link "$UN_HOME"; then FOUND_HOME=true; fi
  if exists_or_link "$UN_LOG"; then FOUND_LOG=true; fi
  read_receipt
  case "$RECEIPT_STATE" in
    invalid) SCAN_ERRORS=$((SCAN_ERRORS + 1)); FOUND_RECEIPT=true ;;
    valid)
      FOUND_RECEIPT=true
      if [[ "$R_CODEX" == true ]] && exists_or_link "$UN_USRLOCAL/bin/codex"; then FOUND_USRLOCAL+=('@openai/codex'); fi
      if [[ "$R_NODE" == true ]] && exists_or_link "$UN_USRLOCAL/bin/node"; then
        FOUND_USRLOCAL+=("Corepack shims (${R_SHIMS[*]})" "Node.js $R_NODE_VERSION")
      fi ;;
  esac
}

found_anything() {
  ((${#FOUND_UNITS[@]} + ${#FOUND_SERVE[@]} + ${#FOUND_DBS[@]} + ${#FOUND_USRLOCAL[@]})) && return 0
  [[ "$FOUND_ACCOUNT" == true || "$FOUND_HOME" == true || "$FOUND_LOG" == true || "$FOUND_RECEIPT" == true ]]
}

join_by() { local sep=$1 out= item; shift; for item in "$@"; do out+="${out:+$sep}$item"; done; printf '%s' "$out"; }

print_plan() {
  local entry routes=() dbs=()
  printf 'The following Soulstream and atom resources will be permanently removed:\n'
  if ((${#FOUND_UNITS[@]})); then printf '  - systemd units (by name): %s\n' "$(join_by ', ' "${FOUND_UNITS[@]}")"; fi
  if ((${#FOUND_SERVE[@]})); then
    for entry in "${FOUND_SERVE[@]}"; do routes+=("https:${entry%%|*} / -> ${entry#*|http://}"); done
    printf '  - Tailscale Serve root routes: %s\n' "$(join_by ', ' "${routes[@]}")"
  fi
  if ((${#FOUND_DBS[@]})); then
    dbs=("${FOUND_DBS[@]}")
    if [[ "$FOUND_ROLE" == true ]]; then dbs+=("role $DB_ROLE"); fi
    printf '  - PostgreSQL databases and role (by name): %s\n' "$(join_by ', ' "${dbs[@]}")"
  fi
  if [[ "$FOUND_ACCOUNT" == true || "$FOUND_HOME" == true ]]; then
    printf '  - System user and home (by name): %s, %s (repositories, workspace, backups, credentials, user CLIs)\n' "$ACCOUNT" "$UN_HOME"
  fi
  if ((${#FOUND_USRLOCAL[@]})); then printf '  - Installer-added global tools in %s (from receipt): %s\n' "$UN_USRLOCAL" "$(join_by ', ' "${FOUND_USRLOCAL[@]}")"; fi
  local files=()
  if [[ "$FOUND_LOG" == true ]]; then files+=("$UN_LOG"); fi
  if [[ "$FOUND_RECEIPT" == true ]]; then files+=("$UN_RECEIPT"); fi
  if ((${#files[@]})); then printf '  - Logs and installer receipt: %s\n' "$(join_by ', ' "${files[@]}")"; fi
  printf '\nWARNING: This permanently deletes all session history, folders, cards, pages, atom documents and instructions, %s/workspace files and worktrees, database backup dumps under %s/soulstream/.local/backups, the administrator password, and saved coding-agent login credentials (Claude, Codex, Antigravity). This cannot be undone.\n' "$UN_HOME" "$UN_HOME"
  if ((SCAN_ERRORS)); then printf 'Some state could not be read; anything that still cannot be read is reported under Failed: at the end.\n'; fi
}

confirm_uninstall() {
  local reply
  [[ "$ASSUME_YES" == true ]] && return 0
  if ! { exec 4<>/dev/tty; } 2>/dev/null; then
    printf 'No interactive terminal available. Re-run with --yes to confirm permanent removal.\n' >&2
    return 1
  fi
  printf 'Type yes (or y) to permanently remove these items [y/N]: ' >&4
  if ! IFS= read -r reply <&4; then
    exec 4<&- 4>&-
    printf '\nAborted. Nothing was removed.\n' >&2
    return 1
  fi
  exec 4<&- 4>&-
  reply=$(trim "$reply")
  case "${reply,,}" in
    y|yes) return 0 ;;
    *) printf 'Aborted. Nothing was removed.\n' >&2; return 1 ;;
  esac
}

# Step 1: stop the units and prove they are stopped. Everything that depends on the services being down waits for this.
step_services() {
  local unit state present=() removed=() have_systemctl=false
  SERVICES_STOPPED=true
  has_cmd systemctl && have_systemctl=true
  for unit in $SERVICE_UNITS; do exists_or_link "$UN_SYSTEMD/$unit" && present+=("$unit"); done
  if [[ "$have_systemctl" == true ]]; then
    for unit in "${present[@]}"; do systemctl stop "$unit" >/dev/null 2>&1; done
    for unit in $SERVICE_UNITS; do
      state=$(trim "$(systemctl is-active "$unit" 2>/dev/null)")
      case "$state" in
        inactive|failed) ;;
        *) SERVICES_STOPPED=false; note_failed "Service $unit: not confirmed stopped (systemctl is-active: ${state:-no output})" ;;
      esac
    done
  elif ((${#present[@]})); then
    SERVICES_STOPPED=false
    note_failed "Services: systemctl is not available, so ${present[*]} cannot be confirmed stopped"
  fi
  if [[ "$SERVICES_STOPPED" != true ]]; then
    note_failed 'Skipped (services not confirmed stopped): remaining processes, PostgreSQL databases, /usr/local tools, the soulstream user and its home'
    return 0
  fi
  for unit in $SERVICE_UNITS; do
    exists_or_link "$UN_SYSTEMD/$unit" || [[ -L "$UN_SYSTEMD/multi-user.target.wants/$unit" ]] || continue
    if [[ "$have_systemctl" == true ]] && exists_or_link "$UN_SYSTEMD/$unit"; then
      systemctl disable "$unit" >/dev/null 2>&1 || note_failed "Service $unit: systemctl disable failed"
    fi
    if rm -f -- "$UN_SYSTEMD/$unit" "$UN_SYSTEMD/multi-user.target.wants/$unit"; then removed+=("$unit"); else note_failed "Service $unit: could not remove its unit files"; fi
  done
  if ((${#removed[@]})); then
    note_removed "systemd units: $(join_by ', ' "${removed[@]}")"
    if [[ "$have_systemctl" == true ]]; then
      systemctl daemon-reload >/dev/null 2>&1 || note_failed 'systemctl daemon-reload failed'
      systemctl reset-failed soulstream-worker.service soulstream-orch.service soulstream-atom.service >/dev/null 2>&1 || true
    fi
  fi
}

# Step 2: end what the soulstream user still runs and clear its crontab; the account is deleted only when nothing is left.
step_processes() {
  local uid rc i
  PROCS_CLEARED=true
  [[ "$SERVICES_STOPPED" == true ]] || return 0
  uid=$(id -u "$ACCOUNT" 2>/dev/null) || return 0
  if ! [[ "$uid" =~ ^[1-9][0-9]{3,9}$ ]] || ((uid == EUID)); then
    PROCS_CLEARED=false
    note_failed "Processes: refusing to signal uid '$uid' of $ACCOUNT (not a regular account uid, or the uid running this script)"
    return 0
  fi
  crontab -u "$ACCOUNT" -r >/dev/null 2>&1 || true
  pgrep -u "$uid" >/dev/null 2>&1; rc=$?
  case "$rc" in
    1) return 0 ;;
    0) ;;
    *) PROCS_CLEARED=false; note_failed "Processes: pgrep failed (exit $rc), so the $ACCOUNT processes could not be checked"; return 0 ;;
  esac
  pkill -TERM -u "$uid" >/dev/null 2>&1
  for i in 1 2 3 4 5; do
    sleep 1
    pgrep -u "$uid" >/dev/null 2>&1; rc=$?
    ((rc == 1)) && return 0
  done
  pkill -KILL -u "$uid" >/dev/null 2>&1
  sleep 1
  pgrep -u "$uid" >/dev/null 2>&1; rc=$?
  case "$rc" in
    1) ;;
    0) PROCS_CLEARED=false; note_failed "Processes: $ACCOUNT processes are still running after SIGKILL" ;;
    *) PROCS_CLEARED=false; note_failed "Processes: pgrep failed (exit $rc) after SIGKILL, so the $ACCOUNT processes could not be checked" ;;
  esac
}

# Step 3: turn off only the root route of each Serve port that proxies to this product.
step_tailscale() {
  local route port proxy attempted=() ports=()
  has_cmd tailscale || return 0
  if ! serve_query; then note_failed 'Tailscale Serve: could not read the serve status'; return 0; fi
  for route in "${SERVE_ROUTES[@]}"; do
    port=${route%%|*}; proxy=${route#*|}
    [[ -n "$(serve_matches "$SERVE_JSON" "$port" "$proxy")" ]] || continue
    attempted+=("$route")
    if ! tailscale serve --https="$port" --set-path=/ off >/dev/null 2>&1; then note_failed "Tailscale Serve: turning off https:$port / failed"; fi
  done
  ((${#attempted[@]})) || return 0
  if ! serve_query; then note_failed 'Tailscale Serve: could not re-read the serve status after turning routes off'; return 0; fi
  for route in "${attempted[@]}"; do
    port=${route%%|*}; proxy=${route#*|}
    if [[ -n "$(serve_matches "$SERVE_JSON" "$port" "$proxy")" ]]; then
      note_failed "Tailscale Serve: https:$port / is still present"
    else
      ports+=("https:$port")
    fi
  done
  if ((${#ports[@]})); then note_removed "Tailscale Serve root routes: $(join_by ', ' "${ports[@]}")"; fi
}

# Step 4: drop the two databases, then the role unless other databases still depend on it.
step_database() {
  local db err rc exists drop_failed=false
  [[ "$SERVICES_STOPPED" == true ]] || return 0
  has_cmd psql || return 0
  if ! pg -c 'SELECT 1' >/dev/null 2>&1; then note_failed 'PostgreSQL: could not connect as the postgres user'; return 0; fi
  for db in $DATABASES; do
    if ! exists=$(pg -c "SELECT datname FROM pg_database WHERE datname = '$db'" 2>/dev/null); then
      drop_failed=true; note_failed "PostgreSQL: could not check database $db"; continue
    fi
    grep -qx "$db" <<< "$exists" || continue
    if pg -c "DROP DATABASE \"$db\" WITH (FORCE);" >/dev/null 2>&1; then note_removed "PostgreSQL database: $db"; else drop_failed=true; note_failed "PostgreSQL: DROP DATABASE $db failed"; fi
  done
  [[ "$drop_failed" == false ]] || return 0
  if ! exists=$(pg -c "SELECT rolname FROM pg_roles WHERE rolname = '$DB_ROLE'" 2>/dev/null); then note_failed "PostgreSQL: could not check role $DB_ROLE"; return 0; fi
  grep -qx "$DB_ROLE" <<< "$exists" || return 0
  err=$(sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -c "DROP ROLE $DB_ROLE;" 2>&1); rc=$?
  if ((rc == 0)); then
    note_removed "PostgreSQL role: $DB_ROLE"
  elif [[ "$err" == *2BP01* ]]; then
    note_kept "PostgreSQL role $DB_ROLE: other databases still depend on it"
  else
    note_failed "PostgreSQL: DROP ROLE $DB_ROLE failed"
  fi
}

# Removes the installer's codex; returns 1 when something that should go could not be removed.
remove_codex() {
  local link=$UN_USRLOCAL/bin/codex module=$UN_USRLOCAL/lib/node_modules/@openai/codex target
  if [[ -L "$link" ]]; then
    target=$(readlink "$link")
    if [[ "$target" != ../lib/node_modules/@openai/codex/* ]]; then note_kept "$link: points to $target, not the installer's codex"; return 0; fi
  elif [[ -e "$link" ]]; then
    note_kept "$link: not a link made by npm install -g"; return 0
  fi
  if ! rm -f -- "$link"; then note_failed "/usr/local: could not remove $link"; return 1; fi
  if ! safe_rm_tree "$module"; then note_failed "/usr/local: could not remove $module"; return 1; fi
  rmdir "$UN_USRLOCAL/lib/node_modules/@openai" 2>/dev/null || true
  note_removed "@openai/codex in $UN_USRLOCAL"
}

# Removes Node.js, last file last: a failed removal keeps bin/node so a rerun still sees the recorded version.
remove_node() {
  local node=$UN_USRLOCAL/bin/node version name link target entry others=() reasons=() ok=true
  exists_or_link "$node" || return 0
  version=$(trim "$("$node" --version 2>/dev/null)")
  [[ "$version" == "$R_NODE_VERSION" ]] || reasons+=("its version is ${version:-unknown} and the receipt recorded $R_NODE_VERSION")
  if [[ -d "$UN_USRLOCAL/lib/node_modules" ]]; then
    for entry in "$UN_USRLOCAL/lib/node_modules"/* "$UN_USRLOCAL/lib/node_modules"/.[!.]*; do
      exists_or_link "$entry" || continue
      case "${entry##*/}" in npm|corepack) ;; *) others+=("${entry##*/}") ;; esac
    done
  fi
  if ((${#others[@]})); then reasons+=("other global packages share lib/node_modules: ${others[*]}"); fi
  if ((${#reasons[@]})); then
    note_kept "Node.js and Corepack shims in $UN_USRLOCAL: $(join_by '; ' "${reasons[@]}")"
    return 0
  fi
  for name in "${R_SHIMS[@]}"; do
    link=$UN_USRLOCAL/bin/$name
    if [[ -L "$link" ]]; then
      target=$(readlink "$link")
      if [[ "$target" == ../lib/node_modules/corepack/* ]]; then
        rm -f -- "$link" || { ok=false; note_failed "/usr/local: could not remove $link"; }
      else
        note_kept "$link: points to $target, not the Corepack shim"
      fi
    elif [[ -e "$link" ]]; then
      note_kept "$link: not a Corepack shim link"
    fi
  done
  for name in $NODE_BUNDLE; do
    safe_rm_tree "$UN_USRLOCAL/$name" || { ok=false; note_failed "/usr/local: could not remove $UN_USRLOCAL/$name"; }
  done
  rmdir "$UN_USRLOCAL/lib/node_modules" 2>/dev/null || true
  if [[ "$ok" != true ]]; then
    note_failed "/usr/local: $node kept because an earlier removal failed; rerun after fixing the cause"
    return 1
  fi
  rm -f -- "$node" || { note_failed "/usr/local: could not remove $node"; return 1; }
  note_removed "Node.js $version and Corepack shims in $UN_USRLOCAL"
}

# Puts the shared /usr/local directories back to the OS owner (root, group root or staff). Earlier installers left
# some of them owned by uid 1000, which the next ordinary account would inherit. This is not part of what is removed,
# so it ignores the receipt. Directories only, not recursive, and the mode is left alone.
reset_usr_local_owners() {
  local expected=root:root rel path owner reset=()
  [[ -e "$STAFF_MARKER" ]] && expected=root:staff
  for rel in $USR_LOCAL_DIRS; do
    path=$UN_USRLOCAL
    [[ "$rel" == . ]] || path=$UN_USRLOCAL/$rel
    [[ -d "$path" && ! -L "$path" ]] || continue
    if ! owner=$(stat -c '%U:%G' -- "$path" 2>/dev/null); then note_failed "/usr/local: could not read the owner of $path"; continue; fi
    [[ "$owner" == "$expected" ]] && continue
    if chown -h "$expected" -- "$path" >/dev/null 2>&1; then reset+=("$path"); else note_failed "/usr/local: could not change the owner of $path to $expected"; fi
  done
  if ((${#reset[@]})); then note_removed "Non-root ownership reset to $expected on: $(join_by ', ' "${reset[@]}")"; fi
}

# Step 5: /usr/local tools by the receipt only, then the owners of the shared directories.
step_usr_local() {
  [[ "$SERVICES_STOPPED" == true ]] || return 0
  remove_usr_local_tools
  reset_usr_local_owners
}

remove_usr_local_tools() {
  local tool paths=() codex_ok=true
  read_receipt
  case "$RECEIPT_STATE" in
    absent)
      for tool in node npm npx corepack pnpm pnpx yarn yarnpkg codex; do
        exists_or_link "$UN_USRLOCAL/bin/$tool" && paths+=("$UN_USRLOCAL/bin/$tool")
      done
      if ((${#paths[@]})); then
        note_kept "No installer receipt, so ${UN_USRLOCAL} tools were left alone. Remove them yourself if nothing else uses them: rm -f ${paths[*]} && rm -rf $UN_USRLOCAL/lib/node_modules/@openai"
      fi
      return 0 ;;
    invalid)
      note_failed "Installer receipt $UN_RECEIPT is unreadable or invalid; $UN_USRLOCAL was left untouched"
      return 0 ;;
  esac
  if [[ "$R_CODEX" == true ]]; then remove_codex || codex_ok=false; fi
  if [[ "$R_NODE" == true ]]; then
    if [[ "$codex_ok" == true ]]; then
      remove_node
    else
      note_failed "/usr/local: Node.js kept because the codex removal failed"
    fi
  elif exists_or_link "$UN_USRLOCAL/bin/node"; then
    note_kept "Node.js in $UN_USRLOCAL was there before the installer ran, so it and the Corepack shims stay"
  fi
}

# Step 6: the account and its home. Only after the services are stopped and no process of the account is left.
step_account() {
  local passwd_line uid home_field
  if [[ "$SERVICES_STOPPED" != true ]]; then return 0; fi
  if [[ "$PROCS_CLEARED" != true ]]; then note_failed "User $ACCOUNT and $UN_HOME were kept because its processes were not cleared"; return 0; fi
  if [[ -L "$UN_HOME" ]]; then note_failed "$UN_HOME is a symbolic link, so it was not removed"; return 0; fi
  if passwd_line=$(getent passwd "$ACCOUNT" 2>/dev/null) && [[ -n "$passwd_line" ]]; then
    uid=$(cut -d: -f3 <<< "$passwd_line"); home_field=$(cut -d: -f6 <<< "$passwd_line")
    if ! [[ "$uid" =~ ^[1-9][0-9]{3,9}$ ]] || [[ "$home_field" != "$UN_HOME" ]]; then
      note_failed "User $ACCOUNT: uid '$uid' or home '$home_field' is not what the installer creates, so it was not removed"
      return 0
    fi
    userdel -r "$ACCOUNT" >/dev/null 2>&1
    if id -u "$ACCOUNT" >/dev/null 2>&1; then note_failed "User $ACCOUNT: userdel did not remove the account"; return 0; fi
    note_removed "User: $ACCOUNT"
  fi
  if exists_or_link "$UN_HOME"; then
    safe_rm_tree "$UN_HOME" || true
  fi
  if exists_or_link "$UN_HOME"; then note_failed "$UN_HOME is still present"; else note_removed "Home directory: $UN_HOME"; fi
}

# Step 7: the install log, and the receipt only when everything else went through.
step_log_and_receipt() {
  if exists_or_link "$UN_LOG"; then
    if rm -f -- "$UN_LOG"; then note_removed "Install log: $UN_LOG"; else note_failed "Could not remove $UN_LOG"; fi
  fi
  if ((${#FAILURES[@]} == 0)) && exists_or_link "$UN_RECEIPT"; then
    if rm -f -- "$UN_RECEIPT"; then
      rmdir "${UN_RECEIPT%/*}" 2>/dev/null || true
      note_removed "Installer receipt: $UN_RECEIPT"
    else
      note_failed "Could not remove $UN_RECEIPT"
    fi
  fi
}

print_summary() {
  local item
  if ((${#REMOVED[@]})); then
    printf '\nRemoved:\n'
    for item in "${REMOVED[@]}"; do printf '  - %s\n' "$item"; done
  fi
  printf '\nKept:\n'
  printf '  - apt packages installed by the installer (postgresql-17, git, jq, tmux and the others) and the PostgreSQL service\n'
  printf '  - Tailscale and this device'\''s login; run "tailscale logout" to disconnect it from your tailnet\n'
  for item in "${KEPT[@]}"; do printf '  - %s\n' "$item"; done
  if ((${#FAILURES[@]})); then
    printf '\nFailed:\n'
    for item in "${FAILURES[@]}"; do printf '  - %s\n' "$item"; done
    printf 'Fix the cause and run the same command again; the installer receipt was kept for that.\n'
  fi
}

# run_uninstall <home> <receipt file> <systemd dir> <usr/local dir> <install log>
# main passes the real locations; tests pass temporary ones.
run_uninstall() {
  set +e
  set -uo pipefail
  UN_HOME=$1 UN_RECEIPT=$2 UN_SYSTEMD=$3 UN_USRLOCAL=$4 UN_LOG=$5
  REMOVED=(); KEPT=(); FAILURES=()
  scan_server
  if ! found_anything && ((SCAN_ERRORS == 0)); then
    printf 'Nothing to uninstall.\n'
    return 0
  fi
  print_plan
  confirm_uninstall || return 1
  step_services
  step_processes
  step_tailscale
  step_database
  step_usr_local
  step_account
  step_log_and_receipt
  print_summary
  ((${#FAILURES[@]} == 0))
}

main() {
  set -uo pipefail
  parse_args "$@"
  if ((EUID != 0)); then printf 'Run again with sudo.\n' >&2; exit 1; fi
  run_uninstall /home/soulstream /etc/soulstream/install-receipt.json /etc/systemd/system /usr/local /var/log/soulstream-install.log
}

if ((${#BASH_SOURCE[@]} == 0)) || [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
