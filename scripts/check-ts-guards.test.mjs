import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const checker = fileURLToPath(new URL('./check-ts-guards.mjs', import.meta.url));
const require = createRequire(new URL('../soul-server-ts/package.json', import.meta.url));
const typescript = dirname(require.resolve('typescript/package.json'));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ts-guards-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(typescript, join(root, 'node_modules/typescript'), 'dir');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['src'],
  }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
  return {
    run(args = ['tsconfig.json']) {
      return spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8' });
    },
  };
}

function clean(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
}

test('중복 import를 잡고 부작용과 네임스페이스 및 템플릿은 통과한다', () => {
  const source = 'export type A = string;\nexport const b = 1;\n';
  const failure = fixture({
    'src/a.ts': source,
    'src/index.ts': "import type { A } from './a';\nimport { b } from './a';\nexport const value: A = String(b);\n",
  }).run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stdout, /^duplicate-import: src\/index\.ts:2 "\.\/a" 2문[^\n]*\n$/);
  const pass = fixture({
    'src/a.ts': source,
    'src/index.ts': "import './a';\nimport * as all from './a';\nimport { b, type A } from './a';\nconst text = `\nimport { b } from './a';\nimport { b } from './a';\n`;\nexport const value: A = String(b + all.b);\n",
  }).run();
  clean(pass);
});

test('문자열 인덱스가 있는 형의 Omit을 잡는다', () => {
  const failure = fixture({
    'src/index.ts': "interface Loose { [key: string]: unknown; id: string; name: string; }\nexport type Named = Omit<Loose, 'id'>;\n",
  }).run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stdout, /^omit-index: src\/index\.ts:2 Omit<Loose, 'id'>[^\n]*\n$/);
  const pass = fixture({
    'src/index.ts': "interface Loose { [key: string]: unknown; id: string; name: string; }\ninterface Strict { id: string; name: string; }\ntype Named = Omit<Strict, 'id'>;\ntype Drop<T> = Omit<T, 'id'>;\ntype Remapped = { [K in keyof Loose as K extends 'id' ? never : K]: Loose[K] };\n",
  }).run();
  clean(pass);
});

test('같은 이름의 ts에 가려진 tsx를 잡는다', () => {
  const failure = fixture({
    'src/view.ts': 'export const a = 1;\n',
    'src/view.tsx': 'export const b = 2;\n',
  }).run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stdout, /^shadowed-source: src\/view\.tsx:1 [^\n]*\n$/);
  const pass = fixture({
    'src/view.ts': 'export const a = 1;\n',
    'src/view-panel.tsx': 'export const b = 2;\n',
  }).run();
  clean(pass);
});

test('인자가 없거나 설정 파일이 없으면 오류로 끝난다', () => {
  const project = fixture({ 'src/index.ts': 'export {};\n' });
  for (const args of [[], ['missing.json']]) {
    const result = project.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /.+/);
  }
});

test('넘기는 곳이 없는 목을 잡고 실제로 쓰는 목은 통과한다', () => {
  const declarations = [
    'declare const vi: { fn<T>(impl?: T): T & { mock: { calls: unknown[] }; mockClear(): void } };',
    'declare const jest: typeof vi;',
    'declare function expect(value: unknown, message?: string): any;',
  ];
  const failure = fixture({ 'src/index.ts': [...declarations,
    'const probe = vi.fn(() => {});',
    'const other = jest.fn<() => void>();',
    'expect(probe.mock.calls.length).toBe(0);',
    'expect(probe).not.toHaveBeenCalled();',
    'other.mockClear();',
  ].join('\n') }).run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stdout, /^unwired-mock: src\/index\.ts:4 probe [^\n]*\nunwired-mock: src\/index\.ts:5 other [^\n]*\n$/);
  const pass = fixture({ 'src/index.ts': [...declarations,
    'declare function run(callback: () => void): void;',
    'const passed = vi.fn(() => {});',
    'run(passed);',
    'const shorthand = vi.fn(() => {});',
    'const deps = { shorthand };',
    'run(deps.shorthand);',
    'const called = vi.fn(() => {});',
    'called();',
    'const valued = vi.fn(() => {});',
    'run({ callback: valued }.callback);',
    'expect(passed).toHaveBeenCalled();',
  ].join('\n') }).run();
  clean(pass);
});

test('상수끼리 견주는 단언을 잡고 시험 대상이 있는 단언은 통과한다', () => {
  const failure = fixture({ 'src/index.ts': [
    'declare function expect(value: unknown, message?: string): any;',
    "const proof = { ready: false, count: -1, tags: ['a', `b`] } as const;",
    "expect(proof).toEqual({ ready: false, count: -1, tags: ['a', 'b'] });",
    'expect(31 + 7).not.toBe(39);',
    'expect(true).toBeTruthy();',
  ].join('\n') }).run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stdout, /^constant-expect: src\/index\.ts:3 expect\(proof\) [^\n]*\nconstant-expect: src\/index\.ts:4 expect\(31 \+ 7\) [^\n]*\nconstant-expect: src\/index\.ts:5 expect\(true\) [^\n]*\n$/);
  const pass = fixture({ 'src/index.ts': [
    'declare const expect: { (value: unknown, message?: string): any; objectContaining(value: unknown): unknown };',
    'declare function mutate(value: { ready: boolean }): void;',
    'declare const actual: string;',
    "expect(['a', 'b']).toContain(actual);",
    "expect(actual).toBe('a');",
    'const input = { ready: false };',
    'mutate(input);',
    'expect(input).toEqual({ ready: true });',
    "const label = 'a';",
    'expect(label).toBe(actual);',
    'expect(480).toBeGreaterThan(Math.floor(834 * 0.5));',
    'expect({ id: 1 }).toEqual(expect.objectContaining({ id: 1 }));',
  ].join('\n') }).run();
  clean(pass);
});
