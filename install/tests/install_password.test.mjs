// The administrator password that Soulstream and atom share: how a first install gets it, how
// an update keeps it and how a later run changes it.
//
// Nothing here reaches the host. install.sh is only sourced (main never runs), every path is temporary, and the
// system commands are the fakes from support/fake_commands.mjs. Terminal input is a pseudo terminal made by
// script(1) (util-linux, `script -qefc`); a run without any terminal is a detached child (setsid).
// Every password in this file is a synthetic value. A check only says whether a value is present or equal, so a
// failing test never prints one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeCommands, runBash } from './support/fake_commands.mjs';
import { startFakeAtom } from './support/fake_atom_server.mjs';
import { copyCatalog, copyCommonFiles } from './support/catalog.mjs';
import { assertHostUntouched, snapshotHost } from './support/host_guard.mjs';

const hostBefore = snapshotHost();
const script = resolve('install/install.sh');
const realPath = (name) => execFileSync('bash', ['-c', 'type -P "$1"', 'bash', name], { encoding: 'utf8' }).trim();
const REAL_BASH = realPath('bash');
const REAL_SCRIPT = realPath('script');
const REAL_STTY = realPath('stty');

const RULE = 'Invalid administrator password: use 8 to 128 printable ASCII characters on a single line, with no leading or trailing space and none of # \\ \' " `\n';
const UNREADABLE = 'Admin password file is not readable.\n';
const API_KEY = 'test-atom-key_0123456789abcdef';
const NEW_PW = 'NewPass5678';
const OLD_PW = 'OldPass1234';
// Everything the value rule allows that is easy to get wrong in a shell, a heredoc or a JSON string.
const ALLOWED = [
  'Abcd1234',
  `${'a1'.repeat(64)}`,
  'correct  horse battery staple',
  'p@ss$w0rd!%^&*()-_=+[]{};:,.<>/?~|',
  'dollar$sign${HOME}',
];
const same = (actual, expected, label) => assert.ok(actual === expected, label);
const lacks = (text, value, label) => assert.ok(!text.includes(value), label);
const envValue = (path, key) => {
  const line = readFileSync(path, 'utf8').split('\n').find((entry) => entry.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
};

const PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
as_soul() { if [[ "$1" == git ]]; then printf abc; else "$@"; fi; }
LOG=$FAKE_DIR/install.log
: >> "$LOG"
exec 3>>"$FAKE_DIR/fd3.log"
`;
// The same, but for a script run on a pseudo terminal: errors and the prompt go to the terminal.
const PTY_PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
trap 'restore_tty_echo; cleanup_temp_files' EXIT
as_soul() { if [[ "$1" == git ]]; then printf abc; else "$@"; fi; }
LOG=$FAKE_DIR/install.log
: >> "$LOG"
exec 3>&2
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'install-password-'));
  const home = join(dir, 'home'), root = join(home, 'soulstream'), atomRoot = join(home, 'atom');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(atomRoot, { recursive: true });
  copyCatalog(root);
  copyCommonFiles(root);
  writeFileSync(join(root, 'config', '.atom-seed-map.json'), '{}');
  const fake = createFakeCommands(dir);
  const t = { dir, home, root, atomRoot, fake, seq: 0 };
  t.env = (extra = {}) => fake.env({ INSTALL_SH: script, HOME_DIR: home, ROOT: root, ATOM_ROOT: atomRoot, ...extra });
  t.run = async (body, extra = {}) => {
    const result = await runBash(PRELUDE + body, [], { env: t.env(extra) });
    fake.assertNoProtectedRequests();
    return result;
  };
  // No controlling terminal: a detached child is a session leader without one, so /dev/tty cannot open.
  t.runDetached = (body, extra = {}) => new Promise((resolvePromise, reject) => {
    const child = spawn(REAL_BASH, ['-c', PRELUDE + body, 'bash'], { env: t.env(extra), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', reject);
    child.on('close', (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, stdout, stderr }); });
  });
  // The body runs on a pseudo terminal. steps: [[pattern, text]]; each text is typed once its pattern shows up in
  // output printed after the previous step. shell is appended to the command (' </dev/null'), prefix goes before it.
  t.runPty = (body, { steps = [], extra = {}, shell = '', prefix = '', inner } = {}) => {
    const file = join(dir, `pty-${++t.seq}.sh`);
    writeFileSync(file, inner ? body : PTY_PRELUDE + body);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(REAL_SCRIPT, ['-qefc', `${prefix}${REAL_BASH} ${file}${shell}`, '/dev/null'], { env: { ...t.env(extra), SHELL: '/bin/sh' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', from = 0, answered = 0;
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        output += chunk;
        while (answered < steps.length) {
          const [pattern, text] = steps[answered];
          const hit = pattern.exec(output.slice(from));
          if (!hit) break;
          from += hit.index + hit[0].length;
          answered += 1;
          child.stdin.write(text);
        }
      });
      child.stdin.on('error', () => {});
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('error', reject);
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        t.fake.assertNoProtectedRequests();
        resolvePromise({ status, signal, output, answered, steps: steps.length });
      });
    });
  };
  t.read = (...parts) => readFileSync(join(...parts), 'utf8');
  t.log = () => (existsSync(join(dir, 'install.log')) ? t.read(dir, 'install.log') : '');
  t.fd3 = () => (existsSync(join(dir, 'fd3.log')) ? t.read(dir, 'fd3.log') : '');
  t.out = () => (existsSync(join(dir, 'stdout.txt')) ? t.read(dir, 'stdout.txt') : '');
  t.cleanup = () => rmSync(dir, { recursive: true, force: true });
  return t;
}

// parse_args alone, from a clean directory. cwd matters for relative password files.
function parse(args, { cwd, env = {}, prefix = '' } = {}) {
  return spawnSync('bash', ['-c', `${prefix}source "$1"; shift; parse_args "$@"; printf 'backends=%s\\n' "$BACKENDS"; [[ -z "\${CHOSEN_ADMIN_PASSWORD:-}" ]] || printf 'chosen\\n'; printf 'source=%s\\n' "$PASSWORD_SOURCE"`, 'bash', script, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
}
const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'install-password-args-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('the password options leave parse_args at exit 0 under errexit, and a relative file survives the change of directory', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'pw'), `${NEW_PW}\n`);
    for (const args of [[], ['--backends', 'claude,codex'], ['--set-admin-password'], ['--admin-password-file', 'pw']]) {
      const result = spawnSync('bash', ['-c', 'set -Eeuo pipefail; source "$1"; shift; parse_args "$@"; prepare_install_cwd; [[ "$CHOSEN_ADMIN_PASSWORD" == "$EXPECTED" ]] && printf same || printf different', 'bash', script, ...args], { encoding: 'utf8', cwd: dir, env: { ...process.env, EXPECTED: args[0] === '--admin-password-file' ? NEW_PW : '' } });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, 'same', args.join(' '));
    }
  });
});

test('a password on the command line, a missing value and both password options are rejected with usage', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'pw'), `${NEW_PW}\n`);
    for (const args of [['--admin-password', 'SynthArgv8x'], ['--admin-password-file'], ['--admin-password-file', '--tailscale'], ['--admin-password-file', 'pw', '--set-admin-password']]) {
      const result = parse(args, { cwd: dir });
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stdout + result.stderr, /Usage: install\.sh .*\[--admin-password-file path \| --set-admin-password\]/);
    }
  });
});

test('a file that is missing, a directory, unreadable or fails while being read stops parse_args with exit 2', () => {
  withDir((dir) => {
    const unreadable = join(dir, 'locked');
    writeFileSync(unreadable, `${NEW_PW}\n`, { mode: 0o000 });
    mkdirSync(join(dir, 'folder'));
    const cases = [join(dir, 'missing'), join(dir, 'folder')];
    // root reads a mode 0000 file, so that case only means something for another user.
    if (process.getuid() !== 0) cases.push(unreadable);
    for (const file of cases) {
      const result = parse(['--admin-password-file', file], { cwd: dir });
      assert.equal(result.status, 2, file);
      assert.equal(result.stderr, UNREADABLE, file);
    }
    // The read command fails after printing a public string: that is a read error, not a bad value.
    const bin = join(dir, 'failing-cat');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cat'), '#!/usr/bin/env bash\nprintf publicvalue\nexit 7\n');
    chmodSync(join(bin, 'cat'), 0o755);
    writeFileSync(join(dir, 'pw'), `${NEW_PW}\n`);
    const result = parse(['--admin-password-file', join(dir, 'pw')], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, UNREADABLE);
    lacks(result.stdout + result.stderr, 'publicvalue', 'the partial read was used');
  });
});

test('the value rule: allowed values are kept byte for byte, everything else is refused with the rule message', () => {
  withDir((dir) => {
    const file = join(dir, 'pw');
    const check = (bytes, accepted, label) => {
      writeFileSync(file, bytes);
      const result = spawnSync('bash', ['-c', 'source "$1"; parse_args --admin-password-file "$2"; [[ "$CHOSEN_ADMIN_PASSWORD" == "$EXPECTED" ]] && printf same || printf different', 'bash', script, file], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8', EXPECTED: accepted ?? '' } });
      if (accepted === null) {
        assert.equal(result.status, 2, label);
        same(result.stderr, RULE, `${label}: message`);
      } else {
        assert.equal(result.status, 0, label);
        same(result.stdout, 'same', label);
      }
    };
    for (const value of ALLOWED) {
      check(`${value}\n`, value, `allowed with LF: ${value.length} chars`);
      check(`${value}\r\n`, value, `allowed with CRLF: ${value.length} chars`);
      check(value, value, `allowed without a line end: ${value.length} chars`);
    }
    const refused = [
      ['', 'empty file'], ['\n', 'empty line'], ['abcdefg\n', '7 characters'], [`${'a'.repeat(129)}\n`, '129 characters'],
      [' pass1234\n', 'leading space'], ['pass1234 \n', 'trailing space'], ['pass1234\r', 'CR without LF'], ['pass\r1234\n', 'CR inside'],
      ['pass#1234\n', 'hash'], ['pass\\1234\n', 'backslash'], ["pass'1234\n", 'single quote'], ['pass"1234\n', 'double quote'], ['pass`1234\n', 'backtick'],
      ['pass\t1234\n', 'tab'], ['pass1234\nsecond\n', 'two lines'], ['pass1234\n\n', 'extra empty line'],
      [Buffer.from('pass\0word1\n'), 'NUL byte'], ['비밀번호입니다암호\n', 'Korean'], ['pass😀word12\n', 'emoji'],
    ];
    for (const [bytes, label] of refused) check(bytes, null, label);
    // 8 and 128 characters are the two edges that are allowed; 7 and 129 above are the two just outside.
    assert.equal(ALLOWED[0].length, 8);
    assert.equal(ALLOWED[1].length, 128);
  });
});

// A fake Soulstream orchestrator on an ephemeral port. Only what wait_and_create_workspace calls.
async function startFakeOrch(password, { jobStatus = 201 } = {}) {
  const requests = [];
  const COOKIE = 'soul_dashboard_auth=fake-orch-session';
  const folders = [];
  const jobs = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url, 'http://fake').pathname;
    requests.push({ method: req.method, path, body });
    const send = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && (path === '/api/health' || path === '/health')) return send(200, { ok: true });
    if (req.method === 'GET' && path === '/api/nodes') return send(200, { nodes: [{ nodeId: 'local', connected: true }] });
    if (req.method === 'POST' && path === '/api/auth/password-login') {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, {}); }
      return parsed.password === password ? send(200, { ok: true }, { 'set-cookie': `${COOKIE}; Path=/; HttpOnly` }) : send(401, {});
    }
    if (path === '/api/folders') {
      if (req.headers.cookie !== COOKIE) return send(401, {});
      if (req.method === 'POST') { folders.push({ id: 'folder-work-1', name: '작업실' }); return send(201, {}); }
      return send(200, { folders });
    }
    if (path === '/api/recurring-jobs' && req.method === 'POST') {
      if (req.headers.cookie !== COOKIE) return send(401, {});
      if (jobStatus >= 300) return send(jobStatus, { error: 'refused' });
      const job = JSON.parse(body);
      if (!jobs.has(job.idempotencyKey)) jobs.set(job.idempotencyKey, job);
      return send(jobStatus, { job: jobs.get(job.idempotencyKey) });
    }
    return send(404, {});
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, jobs, close: () => new Promise((resolvePromise) => server.close(resolvePromise)) };
}

// The test servers listen on ephemeral ports; the installer's own URLs name the production ports, and the fake curl
// refuses those. This wrapper points the two orchestrator URLs at the fake server and then calls the fake curl.
function orchCurlBin(t) {
  const bin = join(t.dir, 'orch-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
args=()
for arg in "$@"; do
  arg=\${arg/#http:\\/\\/127.0.0.1:5200/$FAKE_ORCH_URL}
  arg=\${arg/#http:\\/\\/127.0.0.1:4205/$FAKE_ORCH_URL}
  args+=("$arg")
done
exec "$FAKE_BIN_CURL" "\${args[@]}"
`);
  chmodSync(join(bin, 'curl'), 0o755);
  return bin;
}

test('every allowed value reaches the three files, the atom login, the seed loader and the dashboard login unchanged', async () => {
  for (const value of ALLOWED) {
    const t = setup();
    const atom = await startFakeAtom({ keys: {}, password: value, secret: API_KEY });
    const orch = await startFakeOrch(value);
    try {
      const pwFile = join(t.dir, 'pw');
      writeFileSync(pwFile, `${value}\n`);
      const result = await t.run(`parse_args --backends claude --admin-password-file "$PW_FILE"
ATOM_URL=$FAKE_ATOM_URL
setup_secrets "$ROOT" "$ATOM_ROOT"
init_atom "$ATOM_ROOT"
issue_atom_api_key "$ROOT"
render_config "$HOME_DIR" "$ROOT"
wait_and_create_workspace "$ROOT"
printf 'orch=%s\\n' "$(read_env_value "$ROOT/.env.orch" DASHBOARD_ADMIN_PASSWORD)" > "$FAKE_DIR/read-back"
`, { PW_FILE: pwFile, FAKE_ATOM_URL: atom.url, FAKE_ORCH_URL: orch.url, FAKE_BIN_CURL: join(t.fake.bin, 'curl'), PATH: `${orchCurlBin(t)}:${t.fake.bin}:${process.env.PATH}` });
      assert.equal(result.status, 0, result.stderr);
      same(t.read(t.root, '.admin-password'), `${value}\n`, 'admin-password file');
      same(envValue(join(t.root, '.env.orch'), 'DASHBOARD_ADMIN_PASSWORD'), value, '.env.orch');
      same(envValue(join(t.atomRoot, '.env'), 'DASHBOARD_ADMIN_PASSWORD'), value, 'atom/.env');
      same(t.read(t.dir, 'read-back'), `orch=${value}\n`, 'read_env_value');
      assert.equal(statSync(join(t.root, '.admin-password')).mode & 0o777, 0o600);
      // The fakes answer 401 to any other password, so reaching the last step already proves the login bodies.
      const atomLogin = atom.requests.find((request) => request.path === '/api/auth/password-login');
      same(JSON.parse(atomLogin.body).password, value, 'atom login body');
      const orchLogin = orch.requests.find((request) => request.path === '/api/auth/password-login');
      same(JSON.parse(orchLogin.body).password, value, 'dashboard login body');
      const jobRequests = orch.requests.filter((request) => request.method === 'POST' && request.path === '/api/recurring-jobs');
      assert.equal(jobRequests.length, 1, 'the paused daily review job is registered once');
      const job = JSON.parse(jobRequests[0].body);
      assert.equal(job.idempotencyKey, 'clean-install-daily-review');
      assert.equal(job.name, '일간 정리');
      assert.equal(job.prompt, 'daily-review 스킬을 발동하여 지난 하루의 작업을 정리한다.');
      assert.equal(job.enabled, false);
      assert.equal(job.agentId, 'seosoyoung');
      assert.equal(job.nodeId, 'local');
      assert.equal(job.folderId, 'folder-work-1');
      assert.equal(job.modelPreset, null);
      assert.deepEqual(job.scheduleExpressions, ['0 9 * * *']);
      // The seed loader sends the password file's content in its own login.
      // Asynchronous, so this process can answer the loader's request.
      await runBash('exec node "$@"', [resolve('install/seed/load_atom_seed.mjs'), '--atom-url', atom.url, '--password-file', join(t.root, '.admin-password'), '--state-dir', join(t.dir, 'seed-state')], { env: t.env() });
      const loaderLogins = atom.requests.filter((request) => request.path === '/api/auth/password-login');
      assert.ok(loaderLogins.length >= 2, 'the loader did not log in');
      same(JSON.parse(loaderLogins[loaderLogins.length - 1].body).password, value, 'seed loader login body');
    } finally { await atom.close(); await orch.close(); t.cleanup(); }
  }
});

const WORKSPACE_BODY = `parse_args --backends claude --admin-password-file "$PW_FILE"
setup_secrets "$ROOT" "$ATOM_ROOT"
render_config "$HOME_DIR" "$ROOT"
wait_and_create_workspace "$ROOT"
wait_and_create_workspace "$ROOT"
`;

test('a rerun sends the same job key again and a refused job only warns', async () => {
  for (const jobStatus of [201, 422]) {
    const t = setup();
    const orch = await startFakeOrch('Passw0rd-ok', { jobStatus });
    try {
      const pwFile = join(t.dir, 'pw');
      writeFileSync(pwFile, 'Passw0rd-ok\n');
      writeFileSync(join(t.root, '.atom-api-key'), `${API_KEY}\n`);
      const result = await t.run(WORKSPACE_BODY, { PW_FILE: pwFile, FAKE_ORCH_URL: orch.url, FAKE_BIN_CURL: join(t.fake.bin, 'curl'), PATH: `${orchCurlBin(t)}:${t.fake.bin}:${process.env.PATH}` });
      assert.equal(result.status, 0, result.stderr);
      const posts = orch.requests.filter((request) => request.method === 'POST' && request.path === '/api/recurring-jobs');
      assert.equal(posts.length, 2);
      assert.equal(new Set(posts.map((request) => JSON.parse(request.body).idempotencyKey)).size, 1);
      assert.equal(orch.jobs.size, jobStatus === 201 ? 1 : 0);
      assert.equal(/Could not register the daily review recurring job \(HTTP 422\)/.test(result.stderr), jobStatus === 422);
    } finally { await orch.close(); t.cleanup(); }
  }
});

const seedFiles = (t, { admin, orch, atomEnv, token = true }) => {
  if (admin !== undefined) writeFileSync(join(t.root, '.admin-password'), admin);
  if (orch !== undefined) writeFileSync(join(t.root, '.env.orch'), orch);
  if (atomEnv !== undefined) writeFileSync(join(t.atomRoot, '.env'), atomEnv);
  if (token) writeFileSync(join(t.root, '.atom-api-key'), `${API_KEY}\n`);
};
const existing = (t) => t.run('read_existing_admin_password "$ROOT" "$ATOM_ROOT" > "$FAKE_DIR/existing"');

test('the existing password comes from .admin-password first, then .env.orch, then atom/.env, and an empty file is skipped', async () => {
  const cases = [
    ['all three differ', { admin: 'FromAdminFile1\n', orch: 'DASHBOARD_ADMIN_PASSWORD=FromOrchEnv22\n', atomEnv: 'DASHBOARD_ADMIN_PASSWORD=FromAtomEnv33\n' }, 'FromAdminFile1'],
    ['no .admin-password', { orch: 'DASHBOARD_ADMIN_PASSWORD=FromOrchEnv22\n', atomEnv: 'DASHBOARD_ADMIN_PASSWORD=FromAtomEnv33\n' }, 'FromOrchEnv22'],
    ['an empty .admin-password', { admin: '\n', orch: 'DASHBOARD_ADMIN_PASSWORD=FromOrchEnv22\n' }, 'FromOrchEnv22'],
    ['only atom/.env (Tailscale mode after the file was removed)', { atomEnv: 'JWT_SECRET=x\nDASHBOARD_ADMIN_PASSWORD=FromAtomEnv33\n' }, 'FromAtomEnv33'],
    ['a Tailscale .env.orch without the key', { admin: 'FromAdminFile1\n', orch: 'TAILSCALE_AUTH_ENABLED=true\n' }, 'FromAdminFile1'],
    ['nothing anywhere', {}, ''],
  ];
  for (const [label, files, expected] of cases) {
    const t = setup();
    try {
      seedFiles(t, files);
      const result = await existing(t);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      same(t.read(t.dir, 'existing'), expected, label);
    } finally { t.cleanup(); }
  }
});

test('without a terminal an update keeps what is there and a first install generates 24 hex characters', async () => {
  const kept = setup(), fresh = setup();
  try {
    seedFiles(kept, { admin: `${OLD_PW}\n` });
    const keep = await kept.runDetached('parse_args\nresolve_admin_password "$ROOT" "$ATOM_ROOT"\nprintf "source=%s\\n" "$PASSWORD_SOURCE"\n');
    assert.equal(keep.status, 0, keep.stderr);
    assert.match(keep.stdout, /^source=keep$/m);
    const first = await fresh.runDetached(`parse_args
resolve_admin_password "$ROOT" "$ATOM_ROOT"
printf 'source=%s\\n' "$PASSWORD_SOURCE"
setup_secrets "$ROOT" "$ATOM_ROOT"
finish_message "$ROOT" > "$FAKE_DIR/stdout.txt"
`);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^source=generated_silent$/m);
    const generated = fresh.read(fresh.root, '.admin-password').trim();
    assert.match(generated, /^[0-9a-f]{24}$/);
    assert.ok(fresh.out().includes(`Password for both: sudo cat ${fresh.root}/.admin-password\n`));
    for (const [name, text] of [['stdout', first.stdout + fresh.out()], ['stderr', first.stderr], ['log', fresh.log()], ['argv', fresh.fake.argv()]]) lacks(text, generated, `the generated password is in ${name}`);
  } finally { kept.cleanup(); fresh.cleanup(); }
});

test('--set-admin-password without any terminal is refused before anything changes', async () => {
  const t = setup();
  try {
    seedFiles(t, { admin: `${OLD_PW}\n` });
    const result = await t.runDetached('parse_args --set-admin-password\nresolve_admin_password "$ROOT" "$ATOM_ROOT"\nprintf "not reached\\n"\n');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'No interactive terminal available. Pass --admin-password-file <path> instead.\n');
    lacks(result.stdout, 'not reached', 'the run went on');
    same(t.read(t.root, '.admin-password'), `${OLD_PW}\n`, 'the password file changed');
  } finally { t.cleanup(); }
});

const RESOLVE = (flags = '') => `parse_args --backends claude ${flags}
resolve_admin_password "$ROOT" "$ATOM_ROOT"
printf 'SOURCE=%s\\n' "$PASSWORD_SOURCE"
if [[ "$CHOSEN_ADMIN_PASSWORD" == "$EXPECTED_PW" ]]; then printf 'MATCH\\n'; fi
`;
const PROMPT = /press Enter to generate\): /;
const CONFIRM = /Confirm administrator password: /;

test('a typed password is asked twice with no echo, is stored, and the end message never shows it', async () => {
  const t = setup();
  const typed = 'Synth Pass 91$a!';
  try {
    const result = await t.runPty(`${RESOLVE()}setup_secrets "$ROOT" "$ATOM_ROOT"
finish_message "$ROOT" > "$FAKE_DIR/stdout.txt"
printf 'DONE\\n'
`, { steps: [[PROMPT, `${typed}\n`], [CONFIRM, `${typed}\n`]], extra: { EXPECTED_PW: typed } });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.answered, 2);
    assert.match(result.output, /SOURCE=user_tty/);
    assert.match(result.output, /MATCH/);
    assert.match(result.output, /DONE/);
    lacks(result.output, typed, 'the terminal echoed the password');
    same(t.read(t.root, '.admin-password'), `${typed}\n`, 'stored value');
    assert.ok(t.out().includes(`Password for both: use the administrator password you set (saved in ${t.root}/.admin-password)\n`), t.out());
    for (const [name, text] of [['stdout', t.out()], ['log', t.log()], ['argv', t.fake.argv()]]) lacks(text, typed, `the password is in ${name}`);
  } finally { t.cleanup(); }
});

test('Enter at the first prompt generates a password that appears once, on the terminal only', async () => {
  for (const mode of ['password', 'tailscale']) {
    const t = setup();
    try {
      const flags = mode === 'tailscale' ? '--tailscale' : '';
      const result = await t.runPty(`${RESOLVE(flags)}TAILSCALE_DNS=node.tailnet.ts.net; TAILSCALE_USER=owner@example.com
setup_secrets "$ROOT" "$ATOM_ROOT"
finish_message "$ROOT" > "$FAKE_DIR/stdout.txt"
printf 'DONE\\n'
`, { steps: [[PROMPT, '\n']], extra: { EXPECTED_PW: '' } });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /SOURCE=generated_tty/);
      assert.match(result.output, /A random administrator password will be generated and shown once at the end of installation\./);
      lacks(result.output, 'Confirm administrator password', 'a confirmation was asked for a generated password');
      const generated = t.read(t.root, '.admin-password').trim();
      assert.match(generated, /^[0-9a-f]{24}$/);
      const shown = `Generated administrator password (for Soulstream and atom): ${generated}`;
      assert.equal(result.output.split(shown).length - 1, 1, 'the generated password was not shown exactly once on the terminal');
      assert.ok(result.output.indexOf(shown) > result.output.indexOf('DONE') - 400);
      const line = mode === 'tailscale'
        ? `Atom: https://node.tailnet.ts.net:8443 (generated password shown on your terminal; saved in ${t.root}/.admin-password)\n`
        : `Password for both: shown on your terminal (saved in ${t.root}/.admin-password)\n`;
      assert.ok(t.out().includes(line), t.out());
      if (mode === 'tailscale') assert.ok(t.out().includes('Open https://node.tailnet.ts.net from a tailnet device signed in as owner@example.com.\n'));
      for (const [name, text] of [['stdout', t.out()], ['log', t.log()], ['argv', t.fake.argv()]]) lacks(text, generated, `the generated password is in ${name}`);
      lacks(t.out() + t.log(), 'Generated administrator password', 'the generated line reached stdout or the log');
    } finally { t.cleanup(); }
  }
});

test('a rule violation or two different entries asks again, three failures stop, and end of input aborts', async () => {
  const retry = setup();
  try {
    const result = await retry.runPty(RESOLVE(), { steps: [[PROMPT, 'short\n'], [PROMPT, 'Abcd1234\n'], [CONFIRM, 'Abcd12345\n'], [PROMPT, 'Abcd1234\n'], [CONFIRM, 'Abcd1234\n']], extra: { EXPECTED_PW: 'Abcd1234' } });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.answered, 5);
    assert.ok(result.output.includes(RULE.trim()), 'the rule message');
    assert.match(result.output, /Passwords do not match\./);
    assert.match(result.output, /MATCH/);
  } finally { retry.cleanup(); }
  const three = setup();
  try {
    const result = await three.runPty(RESOLVE(), { steps: [[PROMPT, 'bad\n'], [PROMPT, 'bad\n'], [PROMPT, 'bad\n']], extra: { EXPECTED_PW: '' } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Too many invalid password attempts\./);
    lacks(result.output, 'SOURCE=', 'the run went on after three failures');
  } finally { three.cleanup(); }
  const eof = setup();
  try {
    const result = await eof.runPty(RESOLVE(), { steps: [[PROMPT, '\x04']], extra: { EXPECTED_PW: '' } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Aborted\./);
  } finally { eof.cleanup(); }
});

// A stty that fails where asked and otherwise is the real one.
function fakeStty(t) {
  const bin = join(t.dir, 'stty-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'stty'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/stty.log"
case "\${FAKE_STTY_MODE:-}:$1" in
  save_fails:-g) exit 1 ;;
  save_empty:-g) exit 0 ;;
  echo_fails:-g) printf 'SAVEDSTATE\\n'; exit 0 ;;
  echo_fails:-echo) exit 1 ;;
esac
exec ${REAL_STTY} "$@"
`);
  chmodSync(join(bin, 'stty'), 0o755);
  return bin;
}

test('when echo cannot be turned off the installer stops before it reads anything', async () => {
  for (const mode of ['save_fails', 'save_empty', 'echo_fails']) {
    const t = setup();
    try {
      const result = await t.runPty(RESOLVE(), { extra: { EXPECTED_PW: '', FAKE_STTY_MODE: mode, PATH: `${fakeStty(t)}:${t.fake.bin}:${process.env.PATH}` } });
      assert.equal(result.status, 1, `${mode}: ${result.output}`);
      assert.match(result.output, /Cannot disable terminal echo on \/dev\/tty\. Pass --admin-password-file <path> instead\./);
      lacks(result.output, 'Administrator password for Soulstream', `${mode}: the prompt was shown with echo on`);
      if (mode === 'echo_fails') assert.ok(t.read(t.dir, 'stty.log').split('\n').includes('SAVEDSTATE'), 'the saved state was not restored');
    } finally { t.cleanup(); }
  }
});

test('Ctrl-C at the prompt exits 130 and leaves the terminal echoing', async () => {
  const t = setup();
  try {
    const inner = join(t.dir, 'inner.sh');
    writeFileSync(inner, `${PTY_PRELUDE}${RESOLVE()}`);
    // The outer shell survives the same Ctrl-C so it can look at the terminal afterwards.
    const outer = `trap ':' INT
${REAL_BASH} ${inner}
code=$?
printf 'CODE=%s\\n' "$code"
if ${REAL_STTY} -a </dev/tty | tr ' ' '\\n' | grep -Fxq -- '-echo'; then printf 'ECHO_OFF\\n'; else printf 'ECHO_ON\\n'; fi
`;
    const result = await t.runPty(outer, { inner: true, steps: [[PROMPT, '\x03']], extra: { EXPECTED_PW: '' } });
    assert.match(result.output, /Aborted\./);
    assert.match(result.output, /CODE=130/);
    assert.match(result.output, /ECHO_ON/);
  } finally { t.cleanup(); }
});

test('a terminal that is only the controlling one does not stop an unattended install', async () => {
  for (const [label, redirect] of [['stdin from /dev/null', { shell: ' </dev/null' }], ['stdin from a pipe', { prefix: "printf '' | " }]]) {
    const t = setup();
    try {
      const result = await t.runPty(`${RESOLVE()}setup_secrets "$ROOT" "$ATOM_ROOT"\nprintf 'DONE\\n'\n`, { ...redirect, extra: { EXPECTED_PW: '' } });
      assert.equal(result.status, 0, `${label}: ${result.output}`);
      assert.match(result.output, /SOURCE=generated_silent/);
      assert.match(result.output, /DONE/);
      lacks(result.output, 'Administrator password for Soulstream', `${label}: a prompt was shown`);
      assert.match(t.read(t.root, '.admin-password'), /^[0-9a-f]{24}\n$/);
    } finally { t.cleanup(); }
  }
});

test('--set-admin-password asks on the controlling terminal even when stdin is /dev/null, and Enter makes a new generated value', async () => {
  const typed = setup(), rotated = setup();
  try {
    seedFiles(typed, { admin: `${OLD_PW}\n` });
    const first = await typed.runPty(`${RESOLVE('--set-admin-password')}setup_secrets "$ROOT" "$ATOM_ROOT"\n`, { shell: ' </dev/null', steps: [[PROMPT, `${NEW_PW}\n`], [CONFIRM, `${NEW_PW}\n`]], extra: { EXPECTED_PW: NEW_PW } });
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /SOURCE=user_tty/);
    same(typed.read(typed.root, '.admin-password'), `${NEW_PW}\n`, 'the new password was not stored');
    seedFiles(rotated, { admin: `${OLD_PW}\n` });
    const second = await rotated.runPty(`${RESOLVE('--set-admin-password')}setup_secrets "$ROOT" "$ATOM_ROOT"\n`, { steps: [[PROMPT, '\n']], extra: { EXPECTED_PW: '' } });
    assert.equal(second.status, 0, second.output);
    assert.match(second.output, /SOURCE=generated_tty/);
    const generated = rotated.read(rotated.root, '.admin-password').trim();
    assert.match(generated, /^[0-9a-f]{24}$/);
    assert.ok(generated !== OLD_PW);
  } finally { typed.cleanup(); rotated.cleanup(); }
});

test('a plain rerun after a change that stopped half way finishes with the new password', async () => {
  const t = setup();
  try {
    seedFiles(t, { admin: `${OLD_PW}\n`, orch: `DASHBOARD_ADMIN_PASSWORD=${OLD_PW}\nAUTH_BEARER_TOKEN=SynthBearerKeep1\n`, atomEnv: `DASHBOARD_ADMIN_PASSWORD=${OLD_PW}\nJWT_SECRET=SynthAtomJwtKeep1\n` });
    const pwFile = join(t.dir, 'pw');
    writeFileSync(pwFile, `${NEW_PW}\n`);
    // The change runs as far as init_atom and then fails, before write_configuration.
    const failed = await t.run('parse_args --backends claude --admin-password-file "$PW_FILE"\nsetup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\nfalse\n', { PW_FILE: pwFile });
    assert.equal(failed.status, 1);
    same(t.read(t.root, '.admin-password'), `${NEW_PW}\n`, '.admin-password after the failure');
    same(envValue(join(t.atomRoot, '.env'), 'DASHBOARD_ADMIN_PASSWORD'), NEW_PW, 'atom/.env after the failure');
    same(envValue(join(t.root, '.env.orch'), 'DASHBOARD_ADMIN_PASSWORD'), OLD_PW, '.env.orch after the failure');
    const rerun = await t.run('parse_args --backends claude\nresolve_admin_password "$ROOT" "$ATOM_ROOT"\nsetup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\nrender_config "$HOME_DIR" "$ROOT"\nprintf "source=%s\\n" "$PASSWORD_SOURCE"\n');
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /^source=keep$/m);
    same(t.read(t.root, '.admin-password'), `${NEW_PW}\n`, '.admin-password after the rerun');
    same(envValue(join(t.atomRoot, '.env'), 'DASHBOARD_ADMIN_PASSWORD'), NEW_PW, 'atom/.env after the rerun');
    same(envValue(join(t.root, '.env.orch'), 'DASHBOARD_ADMIN_PASSWORD'), NEW_PW, '.env.orch after the rerun');
    same(envValue(join(t.root, '.env.orch'), 'AUTH_BEARER_TOKEN'), 'SynthBearerKeep1', 'the bearer token was replaced');
  } finally { t.cleanup(); }
});

test('Tailscale mode keeps the password in .admin-password and atom/.env only, and each source has its own end message', async () => {
  const FILE_PW = 'Tail Pass 5678';
  const sources = [
    ['file', ['--admin-password-file', 'PWFILE'], `Atom: https://node.tailnet.ts.net:8443 (use the administrator password you set; saved in ROOT/.admin-password)\n`],
    ['user_tty', [], `Atom: https://node.tailnet.ts.net:8443 (use the administrator password you set; saved in ROOT/.admin-password)\n`],
    ['keep', [], `Atom: https://node.tailnet.ts.net:8443 (password: sudo cat ROOT/.admin-password)\n`],
    ['generated_silent', [], `Atom: https://node.tailnet.ts.net:8443 (password: sudo cat ROOT/.admin-password)\n`],
    ['generated_tty', [], `Atom: https://node.tailnet.ts.net:8443 (password: sudo cat ROOT/.admin-password)\n`],
  ];
  for (const [source, args, line] of sources) {
    const t = setup();
    try {
      const pwFile = join(t.dir, 'pw');
      writeFileSync(pwFile, `${FILE_PW}\n`);
      if (source === 'keep') seedFiles(t, { admin: `${OLD_PW}\n` });
      const set = source === 'file' || source === 'keep' ? '' : `PASSWORD_SOURCE=${source}; CHOSEN_ADMIN_PASSWORD='${source === 'user_tty' ? FILE_PW : ''}'\n`;
      const resolveStep = source === 'keep' ? 'resolve_admin_password "$ROOT" "$ATOM_ROOT"\n' : '';
      const result = await t.runDetached(`parse_args --backends claude --tailscale ${args.map((arg) => (arg === 'PWFILE' ? '"$PW_FILE"' : arg)).join(' ')}
TAILSCALE_DNS=node.tailnet.ts.net; TAILSCALE_USER=owner@example.com
${set}${resolveStep}setup_secrets "$ROOT" "$ATOM_ROOT"
init_atom "$ATOM_ROOT"
printf '%s' "$ADMIN_PASSWORD" > "$FAKE_DIR/admin"
printf '%s\\n' "${API_KEY}" > "$ROOT/.atom-api-key"
render_config "$HOME_DIR" "$ROOT"
finish_message "$ROOT" > "$FAKE_DIR/stdout.txt"
`, { PW_FILE: pwFile });
      assert.equal(result.status, 0, `${source}: ${result.stderr}`);
      const password = t.read(t.dir, 'admin');
      same(t.read(t.root, '.admin-password'), `${password}\n`, `${source}: .admin-password`);
      same(envValue(join(t.atomRoot, '.env'), 'DASHBOARD_ADMIN_PASSWORD'), password, `${source}: atom/.env`);
      assert.ok(!t.read(t.root, '.env.orch').includes('DASHBOARD_ADMIN_PASSWORD'), `${source}: .env.orch has a password key`);
      assert.match(t.read(t.root, '.env.orch'), /^TAILSCALE_AUTH_ENABLED=true$/m);
      assert.ok(t.out().includes('Open https://node.tailnet.ts.net from a tailnet device signed in as owner@example.com.\n'), source);
      assert.ok(t.out().includes(line.replaceAll('ROOT', t.root)), `${source}: ${t.out()}`);
      lacks(t.out() + t.log() + t.fake.argv(), password, `${source}: the password is in stdout, the log or argv`);
    } finally { t.cleanup(); }
  }
});

// A command that fails when FAKE_FAIL_CMD names it and is the real one otherwise.
function failingCommands(t, names) {
  const bin = join(t.dir, 'failing-bin');
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash
[[ "\${FAKE_FAIL_CMD:-}" == ${name} ]] && exit 3
PATH=\${PATH#${bin}:}
exec ${name} "$@"
`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}
const leftovers = (t) => [t.root, t.atomRoot, t.fake.tmp].flatMap((dir) => readdirSync(dir).filter((name) => /^\.admin-password\.|^\.env.*\.[A-Za-z0-9]{6}$|^tmp\./.test(name)).map((name) => join(dir, name)));

test('a failed read or random value stops setup_secrets before any file is written or replaced', async () => {
  for (const failing of ['openssl', 'awk']) {
    const t = setup();
    try {
      seedFiles(t, { admin: `${OLD_PW}\n`, orch: 'ENVIRONMENT=production\n' });
      if (failing === 'openssl') rmSync(join(t.root, '.env.orch'));
      const result = await t.run('if setup_secrets "$ROOT" "$ATOM_ROOT"; then printf ok; else printf "failed=%s" "$?"; fi\n', { FAKE_FAIL_CMD: failing, PATH: `${failingCommands(t, ['openssl', 'awk'])}:${t.fake.bin}:${process.env.PATH}` });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'failed=1', failing);
      same(t.read(t.root, '.admin-password'), `${OLD_PW}\n`, `${failing}: the existing password file changed`);
      assert.deepEqual(leftovers(t), [], `${failing}: temporary files are left`);
    } finally { t.cleanup(); }
  }
});

test('a failing step inside merge_env keeps the target and leaves no temporary file', async () => {
  for (const failing of ['awk', 'cat', 'chmod', 'mv']) {
    const t = setup();
    try {
      const target = join(t.dir, 'target.env'), fresh = join(t.dir, 'fresh.env');
      writeFileSync(target, 'KEEP=1\nOWNED=old\n');
      writeFileSync(fresh, 'OWNED=new\n');
      const result = await t.run('if merge_env "$TARGET" "$FRESH" "OWNED"; then printf ok; else printf "failed=%s" "$?"; fi\n', { TARGET: target, FRESH: fresh, FAKE_FAIL_CMD: failing, PATH: `${failingCommands(t, ['awk', 'cat', 'chmod', 'mv'])}:${t.fake.bin}:${process.env.PATH}` });
      assert.equal(result.stdout, 'failed=1', `${failing}: ${result.stderr}`);
      assert.equal(readFileSync(target, 'utf8'), 'KEEP=1\nOWNED=old\n', failing);
      assert.deepEqual(readdirSync(t.dir).filter((name) => name.startsWith('target.env.')), [], `${failing}: a temporary file is left`);
    } finally { t.cleanup(); }
  }
  const t = setup();
  try {
    const target = join(t.dir, 'target.env'), fresh = join(t.dir, 'fresh.env');
    writeFileSync(target, 'KEEP=1\nOWNED=old\n');
    writeFileSync(fresh, 'OWNED=new\n');
    const result = await t.run('merge_env "$TARGET" "$FRESH" "OWNED"\n', { TARGET: target, FRESH: fresh });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(target, 'utf8'), 'KEEP=1\nOWNED=new\n');
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally { t.cleanup(); }
});

test('a failed write while rendering configuration leaves both env files and the temporary directory as they were', async () => {
  const t = setup();
  try {
    seedFiles(t, { orch: 'GOOGLE_CLIENT_ID=x\n' });
    writeFileSync(join(t.root, '.env.soul-server-ts'), 'CUSTOM=kept\n');
    const before = [t.read(t.root, '.env.orch'), t.read(t.root, '.env.soul-server-ts')];
    // setup_secrets needs mv too, so it runs first without the failing command.
    const second = await t.run('parse_args --backends claude\nsetup_secrets "$ROOT" "$ATOM_ROOT"\n');
    assert.equal(second.status, 0, second.stderr);
    const failed = await t.run('parse_args --backends claude\nif render_config "$HOME_DIR" "$ROOT"; then printf ok; else printf "failed=%s" "$?"; fi\n', { FAKE_FAIL_CMD: 'mv', PATH: `${failingCommands(t, ['mv'])}:${t.fake.bin}:${process.env.PATH}` });
    assert.equal(failed.stdout, 'failed=1', failed.stderr);
    assert.deepEqual([t.read(t.root, '.env.orch'), t.read(t.root, '.env.soul-server-ts')], before);
    assert.deepEqual(leftovers(t), []);
  } finally { t.cleanup(); }
});

test('after a generated password is saved, a failure prints the command that shows it and never the value', async () => {
  const generated = setup(), kept = setup();
  try {
    const failure = (t, prelude) => t.run(`${prelude}INSTALL_ROOT=$ROOT; STEP='Preparing databases'; MAINTENANCE_ENTERED=false
setup_secrets "$ROOT" "$ATOM_ROOT"
trap on_error ERR
false
`);
    const first = await failure(generated, 'parse_args\nPASSWORD_SOURCE=generated_tty\n');
    assert.equal(first.status, 1);
    const password = generated.read(generated.root, '.admin-password').trim();
    assert.ok(generated.fd3().includes(`Administrator password saved (0600, owned by soulstream): sudo cat ${generated.root}/.admin-password\n`), generated.fd3());
    lacks(generated.fd3() + first.stdout + first.stderr + generated.log(), password, 'the password was printed');
    seedFiles(kept, { admin: `${OLD_PW}\n` });
    const second = await failure(kept, 'parse_args\n');
    assert.equal(second.status, 1);
    lacks(kept.fd3(), 'Administrator password saved', 'a kept password was announced');
  } finally { generated.cleanup(); kept.cleanup(); }
});

test('with tracing on, no step of the install writes a secret to the log, the output or argv', async () => {
  const S = { admin: 'SynthAdmin$Pass91a', db: 'SynthDbPass77a2d0', bearer: 'SynthBearer88b3e1', jwt: 'SynthJwt66c4f2', atomJwt: 'SynthAtomJwt55d5a3', atomKey: 'SynthAtomKey44e6b4' };
  for (const source of ['file', 'keep', 'generated_silent']) {
    const t = setup();
    const atom = await startFakeAtom({ keys: {}, password: S.admin, secret: S.atomKey });
    try {
      writeFileSync(join(t.root, '.env.orch'), `DATABASE_URL=postgresql://soulstream:${S.db}@127.0.0.1:5432/soulstream\nAUTH_BEARER_TOKEN=${S.bearer}\nJWT_SECRET=${S.jwt}\n`);
      writeFileSync(join(t.atomRoot, '.env'), `JWT_SECRET=${S.atomJwt}\n`);
      const pwFile = join(t.dir, 'pw');
      writeFileSync(pwFile, `${S.admin}\n`);
      if (source === 'keep') writeFileSync(join(t.root, '.admin-password'), `${S.admin}\n`);
      const flag = source === 'file' ? '--admin-password-file "$PW_FILE"' : '';
      // The same order as run_install: every step but the last goes through run_step, finish_message does not.
      const result = await t.run(`parse_args --backends claude,codex ${flag}
ATOM_URL=$FAKE_ATOM_URL
resolve_admin_password "$ROOT" "$ATOM_ROOT"
run_step 'Preparing secrets' setup_secrets "$ROOT" "$ATOM_ROOT"
run_step 'Preparing databases' setup_database
run_step 'Initializing atom' init_atom "$ATOM_ROOT"
run_step 'Issuing atom API key' issue_atom_api_key "$ROOT"
run_step 'Writing configuration' write_configuration "$HOME_DIR" "$ROOT"
printf '%s' "$ADMIN_PASSWORD" > "$FAKE_DIR/admin"
finish_message "$ROOT"
`, { SHELLOPTS: 'xtrace', FAKE_ATOM_URL: atom.url, PW_FILE: pwFile, ...(source === 'generated_silent' ? {} : {}) });
      if (source === 'generated_silent') {
        // A generated password is not known to the fake atom, so the login fails; the log still must not hold it.
        assert.notEqual(result.status, 0);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stderr.includes('+ '), 'tracing was not on before the installer was sourced');
      }
      const password = existsSync(join(t.dir, 'admin')) ? t.read(t.dir, 'admin') : t.read(t.root, '.admin-password').trim();
      assert.ok(password.length >= 8, `${source}: no password to look for`);
      const outputs = { argv: t.fake.argv(), log: t.log(), stdout: result.stdout, stderr: result.stderr, psql: t.fake.psqlStdin().replaceAll(S.db, 'DB_PLACEHOLDER') };
      for (const [name, text] of Object.entries(outputs)) {
        lacks(text, password, `${source}: the administrator password is in ${name}`);
        if (name === 'psql') continue;
        for (const [label, value] of Object.entries(S)) lacks(text, value, `${source}: ${label} is in ${name}`);
      }
      // The role SQL carries the database password through stdin only.
      assert.ok(t.fake.psqlStdin().includes(S.db), `${source}: the role password never reached psql`);
    } finally { await atom.close(); t.cleanup(); }
  }
});

test('main asks for the password after the checks and before anything is installed', () => {
  const text = readFileSync(script, 'utf8');
  const main = text.slice(text.indexOf('\nmain() {'), text.indexOf('\n}\n', text.indexOf('\nmain() {')));
  const order = ['parse_args "$@"', 'prepare_install_cwd', 'preflight', 'resolve_admin_password /home/soulstream/soulstream /home/soulstream/atom', 'exec 3>&2', 'run_install '].map((fragment) => main.indexOf(fragment));
  assert.ok(order.every((index) => index >= 0), main);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(main.includes("trap 'restore_tty_echo; cleanup_temp_files' EXIT"));
});

test('no password test touched the host', () => {
  assertHostUntouched(hostBefore);
});
