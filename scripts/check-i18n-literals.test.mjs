import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
const script = resolve('scripts/check-i18n-literals.mjs');
let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function setup(source) {
  root = mkdtempSync(join(tmpdir(), 'i18n-literals-'));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/config.json'), JSON.stringify({ roots: ['src'], baseline: 'scripts/baseline.json' }));
  writeFileSync(join(root, 'src/view.tsx'), source);
}
function run(...args) { return spawnSync(process.execPath, [script, '--root', root, '--config', 'scripts/config.json', ...args], { encoding: 'utf8' }); }
test('reports an increase with a location and exits 1', () => {
  setup('const a = "하나";'); assert.equal(run('--init').status, 0);
  writeFileSync(join(root, 'src/view.tsx'), 'const a = "하나"; const b = "둘";');
  const result = run(); assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /view\.tsx:1/);
});
test('reports decreases and updates only decreased counts', () => {
  setup('const a = "하나"; const b = "둘";'); assert.equal(run('--init').status, 0);
  writeFileSync(join(root, 'src/view.tsx'), 'const a = "하나";');
  const result = run(); assert.equal(result.status, 0); assert.match(result.stdout, /--update/);
  assert.equal(run('--update').status, 0); assert.match(readFileSync(join(root, 'scripts/baseline.json'), 'utf8'), /1/);
});
test('ignores dictionary JSON, tests and i18n-ignore lines', () => {
  setup('const a = "무시"; // i18n-ignore\n');
  writeFileSync(join(root, 'src/dictionary.json'), '{"key":"문구"}');
  writeFileSync(join(root, 'src/ignored.test.ts'), 'const a = "시험";');
  assert.equal(run('--init').status, 0); assert.deepEqual(JSON.parse(readFileSync(join(root, 'scripts/baseline.json'), 'utf8')), {});
});
test('only checks selected globs without reading a baseline', () => {
  setup('const a = "하나";');
  writeFileSync(join(root, 'src/other.ts'), 'const b = "둘";');
  let result = run('--only', 'src/view.tsx');
  assert.equal(result.status, 1); assert.match(result.stdout, /view\.tsx:1/); assert.doesNotMatch(result.stdout, /other\.ts/);
  result = run('--only', 'src/missing.ts', '--only', 'src/other.ts');
  assert.equal(result.status, 1); assert.match(result.stdout, /other\.ts:1/);
  assert.equal(run('--only', 'src/missing.ts').status, 0);
});
test('excludes configured globs', () => {
  setup('const a = "하나";');
  writeFileSync(join(root, 'scripts/config.json'), JSON.stringify({ roots: ['src'], baseline: 'scripts/baseline.json', exclude: ['src/view.tsx'] }));
  assert.equal(run('--init').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'scripts/baseline.json'), 'utf8')), {});
});
