// Fake system commands for installer tests.
//
// Every fake records its argv in <dir>/fake-argv.log. sudo, psql, createdb,
// npm, chown, systemctl, journalctl, apt-get, useradd and tailscale never call
// the real command. curl, jq and node are wrappers around the real binaries;
// curl refuses loopback requests to the ports used by the production atom and
// Soulstream on this host and records them in <dir>/fake-blocked.log.

import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROTECTED_PORTS = ['4200', '5200', '4205', '4206'];

const realCommand = (name) => execFileSync('bash', ['-c', 'command -v "$1"', 'bash', name], { encoding: 'utf8' }).trim();

const RECORD = 'printf \'%s\\n\' "== ${0##*/}" "$@" >> "$FAKE_ARGV_LOG"';

function scripts() {
  const curl = realCommand('curl');
  const jq = realCommand('jq');
  return {
    sudo: `${RECORD}
[[ "$1" == -u && "$2" == postgres ]] || { printf 'fake sudo: only -u postgres is allowed\\n' >&2; exit 97; }
shift 2
exec "$@"`,
    psql: `${RECORD}
args=" $* "
if [[ "$args" == *pg_roles* ]]; then if [[ "\${FAKE_ROLE_EXISTS:-0}" == 1 ]]; then printf '1\\n'; fi; exit 0; fi
if [[ "$args" == *pg_database* ]]; then exit 0; fi
if [[ "$args" == *to_regclass* ]]; then printf 't\\n'; exit 0; fi
input=$(cat)
printf '%s\\n' "$input" >> "$FAKE_DIR/psql-stdin.log"
if [[ "\${FAKE_PSQL_FAIL:-0}" == 1 ]]; then printf 'ERROR: %s\\n' "$input"; printf 'ERROR: %s\\n' "$input" >&2; exit 3; fi
exit 0`,
    createdb: `${RECORD}`,
    npm: `${RECORD}`,
    chown: `${RECORD}`,
    // is-active prints FAKE_UNIT_STATE (default inactive) and exits 0 only for active.
    systemctl: `${RECORD}
if [[ "$1" == is-active ]]; then
  state=\${FAKE_UNIT_STATE:-inactive}
  printf '%s\\n' "$state"
  [[ "$state" == active ]]
fi`,
    journalctl: `${RECORD}`,
    'apt-get': `${RECORD}`,
    useradd: `${RECORD}`,
    tailscale: `${RECORD}
case "$1" in
  status)
    if [[ -f "$FAKE_DIR/tailscale-up" ]]; then
      printf '%s' '{"BackendState":"Running","Self":{"DNSName":"node.tailnet.ts.net.","UserID":1,"Tags":[]},"User":{"1":{"LoginName":"owner@example.com"}}}'
    else
      printf '%s' '{"BackendState":"Stopped"}'
    fi ;;
  up) [[ "$2" == --auth-key=file:* ]] || exit 10; : > "$FAKE_DIR/tailscale-up" ;;
esac`,
    curl: `${RECORD}
for arg in "$@"; do
  if [[ "$arg" =~ ^(https?://)?(127\\.0\\.0\\.1|localhost):(${PROTECTED_PORTS.join('|')})([/?#]|$) ]]; then
    printf '%s\\n' "$arg" >> "$FAKE_BLOCKED_LOG"
    exit 97
  fi
done
exec ${curl} "$@"`,
    jq: `${RECORD}
exec ${jq} "$@"`,
    node: `${RECORD}
exec ${process.execPath} "$@"`,
  };
}

export function createFakeCommands(dir) {
  const bin = join(dir, 'fake-bin');
  const tmp = join(dir, 'fake-tmp');
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, body] of Object.entries(scripts())) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const argvLog = join(dir, 'fake-argv.log');
  const blockedLog = join(dir, 'fake-blocked.log');
  return {
    bin,
    tmp,
    argvLog,
    env: (extra = {}) => ({
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: tmp,
      FAKE_DIR: dir,
      FAKE_ARGV_LOG: argvLog,
      FAKE_BLOCKED_LOG: blockedLog,
      ...extra,
    }),
    argv: () => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : ''),
    psqlStdin: () => (existsSync(join(dir, 'psql-stdin.log')) ? readFileSync(join(dir, 'psql-stdin.log'), 'utf8') : ''),
    // Fails the test when any command tried to reach a production port.
    assertNoProtectedRequests: () => {
      if (existsSync(blockedLog)) throw new Error(`request to a protected port: ${readFileSync(blockedLog, 'utf8')}`);
    },
  };
}

// Asynchronous bash runner so an in-process fake server can answer requests.
export function runBash(script, args, { env, timeout = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-c', script, 'bash', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}
