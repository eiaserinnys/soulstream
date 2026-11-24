// The outside of the installer's schema step for install_schema_upgrade.postgres.test.mjs: the test
// PostgreSQL server, sudo -u postgres, systemctl and chown. Nothing here reaches a server other than
// the one TEST_DATABASE_URL names, and no command uses a local socket.

import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const UNSAFE_NAMES = ['soulstream', 'atom', 'reverie', 'serendipity'];

/** Reads TEST_DATABASE_URL. The installer fence needs a loopback server; the database name must say test. */
export function readTestServer(value) {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!/^[a-z0-9_]+$/.test(database) || !database.includes('test') || UNSAFE_NAMES.some((name) => database.includes(name))) {
    throw new Error(`unsafe TEST_DATABASE_URL database name: ${database}`);
  }
  if (!LOOPBACK.has(host)) {
    throw new Error('TEST_DATABASE_URL must name a loopback server; the installer only migrates a local database');
  }
  return {
    host, port: url.port || '5432', database,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
}

/** Environment for a PostgreSQL client that can only reach the test server. */
export function clientEnv(server, home) {
  return {
    PATH: '/usr/bin:/bin', HOME: home, PGHOST: server.host, PGPORT: server.port,
    PGUSER: server.user, PGPASSWORD: server.password, PGCONNECT_TIMEOUT: '5',
  };
}

/** Runs SQL as the test server's administrator and returns the unaligned output. */
export function adminSql(server, pgBin, home, database, sql) {
  return execFileSync(join(pgBin, 'psql'), ['-X', '-qtA', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', '-'], {
    env: clientEnv(server, home), input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function clientMajor(pgBin, name) {
  const output = execFileSync(join(pgBin, name), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  const match = /\(PostgreSQL\) (\d+)/.exec(output);
  if (!match) throw new Error(`cannot read the ${name} version: ${output}`);
  return Number(match[1]);
}

const SUDO = `#!/usr/bin/env bash
# sudo -u postgres psql|pg_dump|pg_restore, sent to the test server as its administrator.
deny() { printf 'test sudo: %s\\n' "$1" >&2; exit 97; }
[[ "$1" == -u && "$2" == postgres ]] || deny 'only -u postgres is allowed'
cmd=$3; shift 3
case "$cmd" in psql|pg_dump|pg_restore) ;; *) deny "$cmd is not allowed" ;; esac
[[ -n "$INSTALLER_TEST_PGHOST" && "$INSTALLER_TEST_PGHOST" != /* ]] || deny 'no test server'
name='^[a-z_][a-z0-9_]*$'
database=false
for arg in "$@"; do
  if [[ "$database" == true ]]; then [[ "$arg" =~ $name ]] || deny "database $arg"; database=false; continue; fi
  case "$arg" in
    -d|--dbname) database=true ;;
    --dbname=*) [[ "\${arg#--dbname=}" =~ $name ]] || deny "$arg" ;;
    -d?*) [[ "\${arg#-d}" =~ $name ]] || deny "$arg" ;;
    -h*|--host*|-p*|--port*|-U*|--username*|*://*|*host=*|*hostaddr=*|*service=*) deny "$arg" ;;
  esac
done
exec env -i PATH=/usr/bin:/bin HOME="$INSTALLER_TEST_HOME" PGHOST="$INSTALLER_TEST_PGHOST" PGPORT="$INSTALLER_TEST_PGPORT" \\
  PGUSER="$INSTALLER_TEST_PGUSER" PGPASSWORD="$INSTALLER_TEST_PGPASSWORD" PGCONNECT_TIMEOUT=5 "$INSTALLER_TEST_PG_BIN/$cmd" "$@"
`;

// A unit is loaded when its file is in the test systemd directory; <state>/<unit> holds "ActiveState MainPID".
// <state>/start-on-show holds "<unit> <n>": the n-th show of that unit finds it started.
const SYSTEMCTL = `#!/usr/bin/env bash
state=$INSTALLER_TEST_UNITS
printf '%s\\n' "$*" >> "$state/calls.log"
read_unit() {
  load=not-found; active=inactive; pid=0
  if [[ -e "$INSTALLER_TEST_SYSTEMD_DIR/$1" ]]; then load=loaded; fi
  if [[ -f "$state/$1" ]]; then read -r active pid < "$state/$1"; fi
}
case "$1" in
  show)
    unit=\${!#}
    if [[ -f "$state/start-on-show" ]]; then
      read -r armed left < "$state/start-on-show"
      if [[ "$armed" == "$unit" ]]; then
        left=$((left - 1))
        if ((left == 0)); then printf 'active 4242\\n' > "$state/$unit"; rm -f "$state/start-on-show"; else printf '%s %s\\n' "$armed" "$left" > "$state/start-on-show"; fi
      fi
    fi
    read_unit "$unit"
    sub=dead
    if [[ "$active" == active ]]; then sub=running; fi
    printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nMainPID=%s\\n' "$load" "$active" "$sub" "$pid" ;;
  stop) shift; for unit in "$@"; do printf 'inactive 0\\n' > "$state/$unit"; done ;;
  is-active) read_unit "$2"; printf '%s\\n' "$active"; [[ "$active" == active ]] ;;
esac
`;

const COMMANDS = {
  sudo: SUDO,
  systemctl: SYSTEMCTL,
  chown: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$INSTALLER_TEST_UNITS/chown.log"\n`,
  // The installer reads its own dump back as root; nothing else runs a client outside sudo.
  pg_restore: `#!/usr/bin/env bash
[[ "$1" == --list && $# -eq 2 ]] || { printf 'test pg_restore: only --list <file> runs outside sudo\\n' >&2; exit 97; }
exec "$INSTALLER_TEST_PG_BIN/pg_restore" --list "$2"
`,
  psql: `#!/usr/bin/env bash\nprintf 'test psql: use sudo -u postgres\\n' >&2\nexit 97\n`,
  pg_dump: `#!/usr/bin/env bash\nprintf 'test pg_dump: use sudo -u postgres\\n' >&2\nexit 97\n`,
};

export function writeCommands(bin) {
  for (const [name, body] of Object.entries(COMMANDS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
}
