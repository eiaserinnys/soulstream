// A sandbox for uninstall.sh and install.sh receipt tests.
//
// Every path is temporary, and PATH holds only two directories: the fake commands from
// support/uninstall-fakes/ and a directory of symlinks to the ordinary tools the scripts need
// (bash, jq, grep, mv, ...). The real systemctl, psql, sudo, userdel, pkill, pgrep, crontab,
// tailscale, npm and corepack are therefore not found by name. The fakes log every call to
// <dir>/fake-argv.log, one line per call.

import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const uninstallScript = resolve('install/uninstall.sh');
export const installScript = resolve('install/install.sh');
const fakesDir = resolve('install/tests/support/uninstall-fakes');

// A uid this host does not have, so a fake pkill or pgrep could never name a real account even if one ran.
export const FAKE_UID = '4242424';
export const UNITS = ['soulstream-worker.service', 'soulstream-orch.service', 'soulstream-atom.service'];
export const NODE_VERSION = 'v22.23.5';
export const SECRET = 'S3CR3T-MARKER-DO-NOT-PRINT';

const TOOLS = ['bash', 'env', 'cat', 'cut', 'grep', 'head', 'tail', 'mktemp', 'mv', 'chmod', 'mkdir', 'rmdir', 'readlink',
  'jq', 'sed', 'ls', 'dirname', 'basename', 'tr', 'sort', 'uniq', 'cp', 'ln', 'date', 'awk', 'wc', 'tee', 'stat', 'true', 'false'];

const realPath = (name) => {
  const found = execFileSync('bash', ['-c', 'type -P "$1"', 'bash', name], { encoding: 'utf8' }).trim();
  if (!found) throw new Error(`${name} is required by the installer tests`);
  return found;
};
const REAL_BASH = realPath('bash');
const REAL_RM = realPath('rm');
const REAL_SCRIPT = (() => { try { return realPath('script'); } catch { return ''; } })();

export const scriptPath = () => REAL_SCRIPT;

export function writeFile(path, body = '', mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode) chmodSync(path, mode);
}

// A temporary root with fake commands. Nothing is installed yet; see installedServer for a full install.
export function createSandbox(prefix = 'uninstall-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(dir, 'fake-bin'), tools = join(dir, 'tools');
  mkdirSync(bin); mkdirSync(tools);
  for (const name of readdirSync(fakesDir)) {
    copyFileSync(join(fakesDir, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  for (const name of TOOLS) symlinkSync(realPath(name), join(tools, name));
  const home = join(dir, 'home', 'soulstream');
  const paths = {
    dir, bin, tools, home,
    receipt: join(dir, 'etc', 'soulstream', 'install-receipt.json'),
    systemd: join(dir, 'etc', 'systemd', 'system'),
    usrLocal: join(dir, 'usr', 'local'),
    log: join(dir, 'var', 'log', 'soulstream-install.log'),
    argvLog: join(dir, 'fake-argv.log'),
  };
  const env = (extra = {}) => ({
    PATH: `${bin}:${tools}`,
    HOME: join(dir, 'caller-home'),
    TMPDIR: dir,
    LANG: 'C.UTF-8',
    FAKE_DIR: dir,
    FAKE_ARGV_LOG: paths.argvLog,
    FAKE_HOME: home,
    FAKE_USRLOCAL: paths.usrLocal,
    FAKE_REAL_RM: REAL_RM,
    UNINSTALL_SH: uninstallScript,
    INSTALL_SH: installScript,
    UN_HOME: home,
    UN_RECEIPT: paths.receipt,
    UN_SYSTEMD: paths.systemd,
    UN_USRLOCAL: paths.usrLocal,
    UN_LOG: paths.log,
    ...extra,
  });
  const calls = () => (existsSync(paths.argvLog) ? readFileSync(paths.argvLog, 'utf8').split('\n').filter(Boolean) : []);
  const called = (pattern) => calls().some((line) => (pattern instanceof RegExp ? pattern.test(line) : line.startsWith(pattern)));
  return { ...paths, env, calls, called, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Runs a bash script in the sandbox with no controlling terminal (setsid), so /dev/tty can never be opened.
export function runBash(sandbox, script, args = [], { extra = {}, timeout = 60000, input = '' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(REAL_BASH, ['-c', script, 'bash', ...args], { env: sandbox.env(extra), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', reject);
    child.on('close', (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, stdout, stderr }); });
  });
}

const RUN_UNINSTALL = `set -uo pipefail
source "$UNINSTALL_SH"
parse_args "$@"
run_uninstall "$UN_HOME" "$UN_RECEIPT" "$UN_SYSTEMD" "$UN_USRLOCAL" "$UN_LOG"
`;

// source uninstall.sh, then run_uninstall with the sandbox paths. Run without --yes only through ptyUninstall.
export const runUninstall = (sandbox, args = ['--yes'], options = {}) => runBash(sandbox, RUN_UNINSTALL, args, options);

// The same run on a pseudo terminal made by script(1), answering the prompt with `input`.
export function ptyUninstall(sandbox, args, input, { extra = {}, timeout = 60000 } = {}) {
  if (!REAL_SCRIPT) throw new Error('script (util-linux) is required for the terminal prompt tests');
  const wrapper = join(sandbox.dir, 'run-uninstall.sh');
  writeFileSync(wrapper, RUN_UNINSTALL);
  return new Promise((resolvePromise, reject) => {
    const command = [REAL_BASH, wrapper, ...args].join(' ');
    const child = spawn(REAL_SCRIPT, ['-qefc', command, '/dev/null'], { env: { ...sandbox.env(extra), SHELL: '/bin/sh' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    // Wait for the prompt before answering, so the answer is not lost before the script opens the terminal.
    let answered = false;
    child.stdout.on('data', () => {
      if (!answered && /\[y\/N\]: /.test(stdout)) { answered = true; child.stdin.end(input); }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', reject);
    child.on('close', (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, stdout, stderr, prompted: answered }); });
  });
}

const link = (target, path) => { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); };

// Lays out what a clean install leaves behind, all inside the sandbox. The returned lists name
// the paths that belong to the product and the paths that belong to someone else.
export function installedServer(sandbox, { receipt = true, node = true, codex = true, serve = true, shims = ['pnpm', 'pnpx', 'yarn', 'yarnpkg'], nodeVersion = NODE_VERSION } = {}) {
  const { home, receipt: receiptPath, systemd, usrLocal, log, dir } = sandbox;
  writeFile(join(home, 'soulstream', '.env.orch'), `AUTH_BEARER_TOKEN=${SECRET}\nTAILSCALE_AUTH_ENABLED=true\n`);
  writeFile(join(home, 'soulstream', '.admin-password'), `${SECRET}\n`);
  writeFile(join(home, 'soulstream', '.local', 'backups', 'soulstream.pgdump'), 'dump');
  writeFile(join(home, 'workspace', 'notes.md'), 'work');
  writeFile(join(home, '.claude-accounts', 'a', 'credentials.json'), SECRET);
  writeFile(join(home, 'atom', '.env'), `JWT_SECRET=${SECRET}\n`);
  for (const unit of UNITS) {
    writeFile(join(systemd, unit), '[Unit]\n');
    link(join(systemd, unit), join(systemd, 'multi-user.target.wants', unit));
  }
  writeFile(join(systemd, 'other.service'), '[Unit]\n');
  writeFile(log, 'install log');
  // Someone else's /usr/local files.
  writeFile(join(usrLocal, 'bin', 'other-tool'), 'keep');
  writeFile(join(usrLocal, 'lib', 'python3', 'keep.txt'), 'keep');
  if (node) {
    writeFile(join(usrLocal, 'bin', 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' '${nodeVersion}'\n`, 0o755);
    for (const name of ['npm', 'npx']) link(`../lib/node_modules/npm/bin/${name}-cli.js`, join(usrLocal, 'bin', name));
    link('../lib/node_modules/corepack/dist/corepack.js', join(usrLocal, 'bin', 'corepack'));
    for (const name of shims) link(`../lib/node_modules/corepack/dist/${name}.js`, join(usrLocal, 'bin', name));
    for (const part of ['lib/node_modules/npm/package.json', 'lib/node_modules/corepack/package.json', 'include/node/node.h', 'share/doc/node/gdbinit', 'share/man/man1/node.1', 'CHANGELOG.md', 'LICENSE', 'README.md']) {
      writeFile(join(usrLocal, part), 'node');
    }
  }
  if (codex) {
    link('../lib/node_modules/@openai/codex/bin/codex.js', join(usrLocal, 'bin', 'codex'));
    writeFile(join(usrLocal, 'lib', 'node_modules', '@openai', 'codex', 'package.json'), 'codex');
  }
  if (receipt) {
    writeFile(receiptPath, `${JSON.stringify({ schema: 1, node_tarball_installed: node, node_version: node ? nodeVersion : null, corepack_shims_created: node ? shims : [], codex_npm_global_installed: codex })}\n`);
  }
  // Fake system state: user, databases, role, Tailscale Serve.
  writeFile(join(dir, 'user'), '');
  writeFile(join(dir, 'pg-dbs'), 'soulstream\natom\n');
  writeFile(join(dir, 'pg-role'), '');
  if (serve) {
    writeFile(join(dir, 'serve.json'), `${JSON.stringify(serveConfig())}\n`);
  }
}

export const serveConfig = ({ extra443 = {}, extra8443 = {}, host = 'node.tailnet.ts.net' } = {}) => ({
  TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
  Web: {
    [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5200' }, ...extra443 } },
    [`${host}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4200' }, ...extra8443 } },
  },
});

// Everything under a directory, as relative paths, with symbolic links listed too.
export function listTree(root) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      out.push(full.slice(root.length + 1));
      if (entry.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

// The index of the first fake-log line that starts with `prefix`, at or after `from`; -1 when none.
export const indexOfCall = (calls, prefix, from = 0) => calls.findIndex((line, i) => i >= from && line.startsWith(prefix));
