// The /usr/local receipt that install.sh writes for uninstall.sh: what it records, that it only grows, and
// that a failed write stops the install. The last tests cover the owners install_node leaves under /usr/local:
// the tar options, and the chown of the shared directories and of this installer's Node.js files. chown, stat and
// find are the fakes from support/uninstall-fakes/, which keep the owners in a table instead of the file system.
//
// install_node and install_codex_global run with temporary RECEIPT_FILE and USR_LOCAL values assigned after
// sourcing (the way the other install tests reassign SYSTEMD_DIR). Downloads, tar, corepack, npm and sudo are
// shell functions defined in the test, so nothing is fetched or installed, and the PATH is the sandbox's: the
// real corepack and npm are not on it. Nothing here writes to /etc/soulstream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, ownerTable, runBash, setOwner, writeFile } from './support/uninstall_env.mjs';
import { assertHostUntouched, snapshotHost } from './support/host_guard.mjs';

const hostBefore = snapshotHost();

// Fakes for everything that would reach the network or the system. TAR_NODE_VERSION is what the fake tarball holds.
const PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
RECEIPT_FILE=$R_FILE
USR_LOCAL=$R_LOCAL
STAFF_MARKER=$STAFF_MARKER_FILE
NODE_VERSION=\${R_NODE_VERSION:-v22.23.5}
curl() {
  local url= out=
  while (($#)); do case "$1" in -o) out=$2; shift ;; http*) url=$1 ;; esac; shift; done
  printf 'curl %s\\n' "$url" >> "$FAKE_ARGV_LOG"
  [[ -z "\${FAKE_CURL_FAIL:-}" ]] || return 22
  case "$url" in
    */SHASUMS256.txt) printf 'abc  node-%s-linux-x64.tar.gz\\n' "$NODE_VERSION" > "$out" ;;
    *) : > "$out" ;;
  esac
}
sha256sum() { cat > /dev/null; [[ -z "\${FAKE_SHA_FAIL:-}" ]]; }
tar() {
  local dest= previous=
  for arg in "$@"; do [[ "$previous" == -C ]] && dest=$arg; previous=$arg; done
  printf 'tar %s\\n' "$dest" >> "$FAKE_ARGV_LOG"
  printf 'tar-args %s\\n' "$*" >> "$FAKE_ARGV_LOG"
  [[ -z "\${FAKE_TAR_FAIL:-}" ]] || return 2
  mkdir -p "$dest/bin"
  printf '#!/usr/bin/env bash\\nprintf "%%s\\\\n" "%s"\\n' "$NODE_VERSION" > "$dest/bin/node"
  chmod 755 "$dest/bin/node"
}
corepack() {
  printf 'corepack %s\\n' "$*" >> "$FAKE_ARGV_LOG"
  local name
  for name in pnpm pnpx yarn yarnpkg; do ln -sfn "../lib/node_modules/corepack/dist/$name.js" "$USR_LOCAL/bin/$name"; done
}
npm() { printf 'npm %s\\n' "$*" >> "$FAKE_ARGV_LOG"; [[ -z "\${FAKE_NPM_FAIL:-}" ]]; }
# The only as_soul call install_codex_global makes is the probe; it finds codex when $CODEX_PRESENT exists.
as_soul() { [[ -e "$CODEX_PRESENT" ]]; }
`;

function setup() {
  const sandbox = createSandbox('install-receipt-');
  const receipt = join(sandbox.dir, 'etc', 'soulstream', 'install-receipt.json');
  const local = join(sandbox.dir, 'usr', 'local');
  mkdirSync(join(local, 'bin'), { recursive: true });
  const run = (body, extra = {}) => runBash(sandbox, PRELUDE + body, [], { extra: { R_FILE: receipt, R_LOCAL: local, CODEX_PRESENT: join(sandbox.dir, 'codex-present'), ...extra } });
  const read = () => JSON.parse(readFileSync(receipt, 'utf8'));
  return { sandbox, receipt, local, run, read };
}
const modeOf = (path) => lstatSync(path).mode & 0o777;
const RECEIPT_KEYS = ['codex_npm_global_installed', 'corepack_shims_created', 'node_tarball_installed', 'node_version', 'schema'];

test('a first install on an empty /usr/local records Node.js, its version and the four shims, with strict permissions', async () => {
  const t = setup();
  try {
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(t.read(), { schema: 1, node_tarball_installed: true, node_version: 'v22.23.5', corepack_shims_created: ['pnpm', 'pnpx', 'yarn', 'yarnpkg'], codex_npm_global_installed: false });
    assert.equal(modeOf(t.receipt), 0o600);
    assert.equal(modeOf(join(t.receipt, '..')), 0o700);
    assert.deepEqual(Object.keys(t.read()).sort(), RECEIPT_KEYS);
  } finally { t.sandbox.cleanup(); }
});

test('codex is recorded only when this run installs it', async () => {
  const t = setup();
  try {
    const result = await t.run('install_node; install_codex_global');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(t.read().codex_npm_global_installed, true);
    assert.ok(t.sandbox.called('npm install -g @openai/codex'));
  } finally { t.sandbox.cleanup(); }
  const present = setup();
  try {
    writeFileSync(join(present.sandbox.dir, 'codex-present'), '');
    const result = await present.run('install_node; install_codex_global');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(present.read().codex_npm_global_installed, false);
    assert.equal(present.sandbox.called('npm '), false);
  } finally { present.sandbox.cleanup(); }
});

test('a rerun keeps what the first run recorded, and a later Node.js version replaces node_version', async () => {
  const t = setup();
  try {
    let result = await t.run('install_node; install_codex_global');
    assert.equal(result.status, 0, result.stderr);
    const first = t.read();
    // Same version: nothing is downloaded, and the receipt is the same even though the shims and codex already exist.
    writeFileSync(join(t.sandbox.dir, 'codex-present'), '');
    result = await t.run('install_node; install_codex_global');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(t.read(), first);
    assert.equal(t.sandbox.calls().filter((line) => line.startsWith('tar ')).length, 1);
    // A newer Node.js that this installer unpacks over its own.
    result = await t.run('install_node', { R_NODE_VERSION: 'v22.30.0' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(t.read(), { ...first, node_version: 'v22.30.0' });
    assert.equal(t.sandbox.calls().filter((line) => line.startsWith('tar ')).length, 2);
  } finally { t.sandbox.cleanup(); }
});

test('a Node.js that was already there stays out of the receipt, whichever version is unpacked over it', async () => {
  for (const existing of ['v20.0.0', 'v22.23.5']) {
    const t = setup();
    try {
      writeFile(join(t.local, 'bin', 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' '${existing}'\n`, 0o755);
      const result = await t.run('install_node');
      assert.equal(result.status, 0, result.stderr);
      const receipt = t.read();
      assert.equal(receipt.node_tarball_installed, false, existing);
      assert.equal(receipt.node_version, null, existing);
      // The shims are still this run's own.
      assert.deepEqual(receipt.corepack_shims_created, ['pnpm', 'pnpx', 'yarn', 'yarnpkg'], existing);
      // And a rerun does not promote it.
      const again = await t.run('install_node');
      assert.equal(again.status, 0, again.stderr);
      assert.equal(t.read().node_tarball_installed, false, existing);
    } finally { t.sandbox.cleanup(); }
  }
});

test('shims that were already there are not recorded, and a shim recorded once stays recorded', async () => {
  const t = setup();
  try {
    writeFile(join(t.local, 'bin', 'pnpm'), 'someone elses pnpm');
    writeFileSync(join(t.local, 'target'), '');
    symlinkSync(join(t.local, 'target'), join(t.local, 'bin', 'yarn'));
    let result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(t.read().corepack_shims_created, ['pnpx', 'yarnpkg']);
    // On the rerun every shim exists, yet the earlier record is not shrunk.
    result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(t.read().corepack_shims_created, ['pnpx', 'yarnpkg']);
  } finally { t.sandbox.cleanup(); }
});

test('a failed npm install -g leaves the codex field false and stops, even when called under || return 1', async () => {
  const t = setup();
  try {
    // install_clis calls the function as `install_codex_global || return 1`, which turns errexit off inside it.
    const result = await t.run('install_node; run() { install_codex_global || return 1; }; run', { FAKE_NPM_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.ok(t.sandbox.called('npm install -g @openai/codex'));
    assert.equal(t.read().codex_npm_global_installed, false);
  } finally { t.sandbox.cleanup(); }
});

test('a failed download, checksum or unpack stops install_node before Node.js is recorded', async () => {
  for (const failure of ['FAKE_CURL_FAIL', 'FAKE_SHA_FAIL', 'FAKE_TAR_FAIL']) {
    const t = setup();
    try {
      const result = await t.run('install_node', { [failure]: '1' });
      assert.notEqual(result.status, 0, failure);
      assert.deepEqual(t.read(), { schema: 1, node_tarball_installed: false, node_version: null, corepack_shims_created: [], codex_npm_global_installed: false }, failure);
      assert.equal(t.sandbox.called('corepack '), false, failure);
    } finally { t.sandbox.cleanup(); }
  }
});

test('a receipt that cannot be written stops install_node before it touches /usr/local', async () => {
  const t = setup();
  try {
    // The receipt's directory cannot be created: a regular file sits where it should go. This holds for root too.
    writeFile(join(t.sandbox.dir, 'etc'), 'a file, not a directory');
    const result = await t.run('install_node');
    assert.notEqual(result.status, 0);
    assert.equal(t.sandbox.called('tar '), false);
    assert.equal(t.sandbox.called('curl '), false);
    assert.equal(t.sandbox.called('corepack '), false);
  } finally { t.sandbox.cleanup(); }
});

test('a receipt that is not valid JSON stops install_node instead of being overwritten', async () => {
  const t = setup();
  try {
    writeFile(t.receipt, 'not json');
    chmodSync(t.receipt, 0o600);
    const result = await t.run('install_node');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(t.receipt, 'utf8'), 'not json');
    assert.equal(t.sandbox.called('tar '), false);
  } finally { t.sandbox.cleanup(); }
});

// What install_node corrects: these directories, and these Node.js paths when the receipt says the installer unpacked Node.js.
const SHARED_DIRS = ['.', 'bin', 'lib', 'include', 'share', 'share/man', 'share/man/man1', 'share/doc', 'lib/node_modules'];
const NODE_PATHS = ['bin/node', 'bin/npm', 'bin/npx', 'bin/corepack', 'lib/node_modules/npm', 'lib/node_modules/corepack', 'include/node', 'share/doc/node', 'share/man/man1/node.1', 'CHANGELOG.md', 'LICENSE', 'README.md'];
const BAD = 'soulstream:soulstream';
const dirOf = (local, rel) => (rel === '.' ? local : join(local, rel));
const chownCalls = (t) => t.sandbox.calls().filter((line) => line.startsWith('chown '));

// A /usr/local the way base-files leaves it, plus the Node.js files an earlier run unpacked (the fake tar writes bin/node only).
const NODE_DIRS = ['lib/node_modules/npm', 'lib/node_modules/corepack', 'include/node', 'share/doc/node'];
function populate(t) {
  for (const rel of SHARED_DIRS) mkdirSync(dirOf(t.local, rel), { recursive: true });
  for (const rel of NODE_PATHS.filter((path) => path !== 'bin/node')) writeFile(join(t.local, rel, ...(NODE_DIRS.includes(rel) ? ['file'] : [])), 'node');
}
const allBad = (t) => { for (const rel of SHARED_DIRS) setOwner(t.sandbox, dirOf(t.local, rel), BAD); };

test('tar unpacks as the caller, not as the archive owner, and keeps the owner of directories that exist', async () => {
  const t = setup();
  try {
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    const [tarArgs] = t.sandbox.calls().filter((line) => line.startsWith('tar-args '));
    assert.ok(tarArgs.split(' ').includes('--no-same-owner'), tarArgs);
    assert.ok(tarArgs.split(' ').includes('--no-overwrite-dir'), tarArgs);
    assert.match(tarArgs, /--strip-components=1/);
  } finally { t.sandbox.cleanup(); }
});

test('owners: a server an earlier installer left with uid 1000 directories and Node.js files gets them back, and only them', async () => {
  const t = setup();
  try {
    populate(t);
    allBad(t);
    const bundleOwned = NODE_PATHS.map((rel) => join(t.local, rel));
    for (const path of bundleOwned) setOwner(t.sandbox, path, BAD);
    // Deep inside a bundle directory, with the directory itself root: one wrong file is enough.
    setOwner(t.sandbox, join(t.local, 'lib', 'node_modules', 'npm'), 'root:root');
    setOwner(t.sandbox, join(t.local, 'lib', 'node_modules', 'npm', 'file'), BAD);
    // Not the installer's: neighbours in the same directories.
    const neighbours = [join(t.local, 'bin', 'other-tool'), join(t.local, 'lib', 'python3')];
    for (const path of neighbours) setOwner(t.sandbox, path, BAD);
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    const dirCalls = SHARED_DIRS.map((rel) => `chown -h root:root -- ${dirOf(t.local, rel)}`);
    const bundleCalls = NODE_PATHS.map((rel) => `chown -hR root:root -- ${join(t.local, rel)}`);
    assert.deepEqual(chownCalls(t), [...dirCalls, ...bundleCalls]);
    assert.deepEqual(ownerTable(t.sandbox), Object.fromEntries(neighbours.map((path) => [path, BAD])));
    assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('Ownership under ')).length, 1, result.stdout);
    assert.ok(result.stdout.includes(`reset on: ${dirOf(t.local, '.')} ${join(t.local, 'bin')} `), result.stdout);
    assert.equal(t.read().node_tarball_installed, true);
  } finally { t.sandbox.cleanup(); }
});

test('owners: a rerun after the fix changes nothing and prints nothing; the same-version run that skips tar still fixes', async () => {
  const t = setup();
  try {
    populate(t);
    allBad(t);
    let result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Ownership under /m);
    const first = t.sandbox.calls().length;
    result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(chownCalls(t).length, SHARED_DIRS.length);
    assert.equal(t.sandbox.calls().filter((line) => line.startsWith('tar ')).length, 1);
    assert.ok(t.sandbox.calls().length > first);
    // The owners drift again; the version matches so tar does not run, and the directories still go back.
    setOwner(t.sandbox, join(t.local, 'bin'), BAD);
    setOwner(t.sandbox, join(t.local, 'include', 'node'), BAD);
    result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(t.sandbox.calls().filter((line) => line.startsWith('tar ')).length, 1);
    assert.deepEqual(chownCalls(t).slice(SHARED_DIRS.length), [`chown -h root:root -- ${join(t.local, 'bin')}`, `chown -hR root:root -- ${join(t.local, 'include', 'node')}`]);
    assert.deepEqual(ownerTable(t.sandbox), {});
  } finally { t.sandbox.cleanup(); }
});

test('owners: a first install on a server with root-owned directories calls no chown and prints nothing', async () => {
  const t = setup();
  try {
    populate(t);
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(chownCalls(t), []);
    assert.equal(result.stdout, '');
  } finally { t.sandbox.cleanup(); }
});

test('owners: a Node.js that was already there is not the installer\'s, so its files keep their owner while the directories are fixed', async () => {
  const t = setup();
  try {
    populate(t);
    writeFile(join(t.local, 'bin', 'node'), '#!/usr/bin/env bash\nprintf "%s\\n" v20.0.0\n', 0o755);
    allBad(t);
    for (const rel of NODE_PATHS) setOwner(t.sandbox, join(t.local, rel), BAD);
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(t.read().node_tarball_installed, false);
    assert.deepEqual(chownCalls(t), SHARED_DIRS.map((rel) => `chown -h root:root -- ${dirOf(t.local, rel)}`));
    assert.equal(t.sandbox.called('find '), false);
    assert.deepEqual(Object.keys(ownerTable(t.sandbox)).sort(), NODE_PATHS.map((rel) => join(t.local, rel)).sort());
  } finally { t.sandbox.cleanup(); }
});

test('owners: the expected owner is root:staff when the base-files marker file exists, and directories are compared by owner and group', async () => {
  const t = setup();
  try {
    populate(t);
    writeFile(t.sandbox.staffMarker, '');
    setOwner(t.sandbox, join(t.local, 'lib'), 'root:staff');
    setOwner(t.sandbox, join(t.local, 'include'), 'root:root');
    setOwner(t.sandbox, join(t.local, 'share'), BAD);
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    // Everything else is root:root, which is not root:staff either.
    assert.ok(chownCalls(t).every((line) => line.startsWith('chown -h root:staff -- ')), chownCalls(t).join('\n'));
    assert.equal(chownCalls(t).length, SHARED_DIRS.length - 1);
    assert.equal(chownCalls(t).some((line) => line.endsWith(` -- ${join(t.local, 'lib')}`)), false);
    assert.match(result.stdout, /^Ownership under .* reset on: /m);
  } finally { t.sandbox.cleanup(); }
});

test('owners: a directory that is a link, and one that is missing, are left alone', async () => {
  const t = setup();
  try {
    populate(t);
    rmSync(join(t.local, 'share', 'doc'), { recursive: true });
    mkdirSync(join(t.sandbox.dir, 'elsewhere'));
    symlinkSync(join(t.sandbox.dir, 'elsewhere'), join(t.local, 'share', 'doc'));
    rmSync(join(t.local, 'share', 'man', 'man1'), { recursive: true });
    setOwner(t.sandbox, join(t.local, 'share', 'doc'), BAD);
    setOwner(t.sandbox, join(t.local, 'share', 'man', 'man1'), BAD);
    const result = await t.run('install_node');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(chownCalls(t).some((line) => /share\/doc$|man1$/.test(line)), false, chownCalls(t).join('\n'));
  } finally { t.sandbox.cleanup(); }
});

test('owners: a failed chown stops install_node with a non-zero exit', async () => {
  for (const [label, wrong, failAt] of [['a directory', 'bin', 'bin'], ['a Node.js file', 'lib/node_modules/npm', 'node_modules/npm']]) {
    const t = setup();
    try {
      populate(t);
      setOwner(t.sandbox, join(t.local, wrong), BAD);
      const result = await t.run('install_node; printf "after\\n"', { FAKE_CHOWN_FAIL: failAt });
      assert.notEqual(result.status, 0, label);
      assert.doesNotMatch(result.stdout, /after/, label);
      assert.deepEqual(ownerTable(t.sandbox), { [join(t.local, wrong)]: BAD }, label);
    } finally { t.sandbox.cleanup(); }
  }
  // An owner that cannot be read, or searched, stops it too.
  for (const extra of [{ FAKE_STAT_FAIL: '1' }, { FAKE_FIND_FAIL: '1' }]) {
    const t = setup();
    try {
      populate(t);
      const result = await t.run('install_node; printf "after\\n"', extra);
      assert.notEqual(result.status, 0, JSON.stringify(extra));
      assert.doesNotMatch(result.stdout, /after/);
    } finally { t.sandbox.cleanup(); }
  }
});

test('no test created /etc/soulstream or the install log on this host', () => {
  assertHostUntouched(hostBefore);
});
