// install.sh run from a shell whose umask is 077 (a root login that tightened it): the install steps must still
// create files other accounts can read, or the soulstream account cannot run what root installed with npm.
// The real main runs; preflight, resolve_admin_password, run_install and the /var/log writes are shell functions
// defined here, and the fake run_install records the modes of what it creates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installScript = resolve('install/install.sh');

const SCRIPT = `umask 077
source "$INSTALL_SH"
preflight() { :; }
resolve_admin_password() { :; }
touch() { :; }
chmod() { :; }
run_install() { : > "$OUT_DIR/file"; mkdir "$OUT_DIR/dir"; }
main
`;

test('main runs the install steps at umask 022 when the calling shell has umask 077', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-umask-'));
  try {
    const result = spawnSync('bash', ['-c', SCRIPT], { encoding: 'utf8', env: { ...process.env, INSTALL_SH: installScript, OUT_DIR: dir } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(join(dir, 'file')).mode & 0o777, 0o644);
    assert.equal(lstatSync(join(dir, 'dir')).mode & 0o777, 0o755);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
