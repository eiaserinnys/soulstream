import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scratchPaths, scratchSubpath } from '../common-files/lib/scratch_workspace.mjs';

const BUNDLE = resolve('install/common-files');
const CHECKER = join(BUNDLE, 'skills/html-make/scripts/check-ui-css.mjs');
const CONFIG = join(BUNDLE, 'skills/html-make/scripts/ui-css-check.config.json');

function workFolder(style) {
  const dir = mkdtempSync(join(tmpdir(), 'common-files-'));
  writeFileSync(join(dir, 'tokens.css'), ':root { --ink: #101010; --gap: 8px; }\n');
  writeFileSync(join(dir, 'style.css'), style);
  writeFileSync(join(dir, 'ui-css-baseline.json'), '{}\n');
  return dir;
}
const check = (dir) => spawnSync('node', [CHECKER, '--root', dir, '--config', CONFIG], { encoding: 'utf8' });

test('the bundled CSS checker is the repository script, byte for byte', () => {
  assert.ok(readFileSync(CHECKER).equals(readFileSync(resolve('scripts/check-ui-css.mjs'))));
  const source = readFileSync(CHECKER, 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 0 && imports.every((name) => name.startsWith('node:')), `non-builtin import: ${imports}`);
});

test('the bundled CSS checker passes tokenized CSS and reports literals outside tokens.css', () => {
  const clean = workFolder('body { color: var(--ink); margin: var(--gap); }\n');
  const dirty = workFolder('body { color: #202020; margin: 8px; }\n');
  try {
    const passed = check(clean);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    const failed = check(dirty);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /color-literal style\.css/);
    assert.match(failed.stdout, /spacing-literal style\.css/);
  } finally { rmSync(clean, { recursive: true, force: true }); rmSync(dirty, { recursive: true, force: true }); }
});

test('scratch_workspace resolves .local/tmp and .local/artifacts and refuses paths that leave them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scratch-'));
  try {
    mkdirSync(join(dir, 'cwd'));
    assert.deepEqual(scratchPaths({ SCRATCH_WORKSPACE_DIR: dir }, '/elsewhere'), { root: dir, tmp: join(dir, '.local', 'tmp'), artifacts: join(dir, '.local', 'artifacts') });
    assert.equal(scratchPaths({}, join(dir, 'cwd')).root, join(dir, 'cwd'));
    assert.equal(scratchPaths({ SCRATCH_WORKSPACE_DIR: '  ' }, join(dir, 'cwd')).root, join(dir, 'cwd'));
    assert.equal(scratchSubpath('tmp', 'job/run.mjs', { SCRATCH_WORKSPACE_DIR: dir }), join(dir, '.local', 'tmp', 'job', 'run.mjs'));
    assert.throws(() => scratchSubpath('artifacts', '../outside', { SCRATCH_WORKSPACE_DIR: dir }), /escapes/);
    assert.throws(() => scratchSubpath('other', 'x', { SCRATCH_WORKSPACE_DIR: dir }), /kind/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
