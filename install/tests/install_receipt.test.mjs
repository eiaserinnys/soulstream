// The /usr/local receipt that install.sh writes for uninstall.sh: what it records, that it only grows, and
// that a failed write stops the install.
//
// install_node and install_codex_global run with temporary RECEIPT_FILE and USR_LOCAL values assigned after
// sourcing (the way the other install tests reassign SYSTEMD_DIR). Downloads, tar, corepack, npm and sudo are
// shell functions defined in the test, so nothing is fetched or installed, and the PATH is the sandbox's: the
// real corepack and npm are not on it. Nothing here writes to /etc/soulstream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSandbox, runBash, writeFile } from './support/uninstall_env.mjs';
import { assertHostUntouched, snapshotHost } from './support/host_guard.mjs';

const hostBefore = snapshotHost();

// Fakes for everything that would reach the network or the system. TAR_NODE_VERSION is what the fake tarball holds.
const PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
RECEIPT_FILE=$R_FILE
USR_LOCAL=$R_LOCAL
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

test('no test created /etc/soulstream or the install log on this host', () => {
  assertHostUntouched(hostBefore);
});
