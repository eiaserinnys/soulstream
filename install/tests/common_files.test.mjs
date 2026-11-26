import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
