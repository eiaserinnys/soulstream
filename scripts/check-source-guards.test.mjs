import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const checker = fileURLToPath(new URL('./check-source-guards.mjs', import.meta.url));
const config = JSON.parse(readFileSync(new URL('./source-guards.config.json', import.meta.url), 'utf8'));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'source-guards-'));
  roots.push(root);
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write('scripts/source-guards.config.json', JSON.stringify({ ...config, canonicalModules: {}, ...overrides }));
  write('packages/wire-schema/generated/typescript/index.ts', 'export const SSE_EVENT_TYPES = [] as const;\n');
  write('packages/wire-schema/package.json', '{}');
  write('packages/soul-ui/src/shared/sse-events.ts', '');
  write('packages/soul-ui/src/index.ts', "export * from './shared/sse-events';\n");
  for (const packageName of config.reexportPackages) {
    const parent = dirname(config.packages[packageName]);
    write(`${parent}/package.json`, JSON.stringify({ name: parent.split('/').pop() }));
  }
  return {
    write,
    run() {
      return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
    },
  };
}

function violates(result, rule) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^${rule}: `, 'm'));
}

function clean(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
}

test('wire-copies는 생성 타입 재선언을 잡고 파생은 통과한다', () => {
  const generated = 'export interface GeneratedThing {\n  id: string;\n}\nexport const SSE_EVENT_TYPES = [] as const;\n';
  const failure = fixture();
  failure.write('packages/wire-schema/generated/typescript/index.ts', generated);
  failure.write('orch-server-ts/src/index.ts', 'export interface GeneratedThing {\n  id: string;\n}\n');
  violates(failure.run(), 'wire-copies');

  const pass = fixture();
  pass.write('packages/wire-schema/generated/typescript/index.ts', generated);
  pass.write('orch-server-ts/src/index.ts', "export type GeneratedThing = Pick<OriginalThing, 'id'>;\n");
  clean(pass.run());
});

test('sse-alias-only는 sse-events.ts의 type 리터럴 칸을 잡는다', () => {
  const failure = fixture();
  failure.write('packages/soul-ui/src/shared/sse-events.ts', 'export interface LegacyEvent {\n  type: "legacy";\n}\n');
  violates(failure.run(), 'sse-alias-only');

  const pass = fixture();
  pass.write('packages/soul-ui/src/shared/sse-events.ts', 'export type LegacyEvent = GeneratedEvent;\n');
  pass.write('packages/soul-ui/src/index.ts', "export * from './shared/sse-events';\n");
  clean(pass.run());
});

test('sse-sender는 보내는 자리가 없는 SSE 이벤트를 잡는다', () => {
  const generated = 'export const SSE_EVENT_TYPES = ["lonely_event"] as const;\n';
  const failure = fixture();
  failure.write('packages/wire-schema/generated/typescript/index.ts', generated);
  violates(failure.run(), 'sse-sender');

  const pass = fixture();
  pass.write('packages/wire-schema/generated/typescript/index.ts', generated);
  pass.write('orch-server-ts/src/index.ts', 'export const EVENT = "lonely_event";\n');
  clean(pass.run());
});

test('fingerprints는 정본 파일 밖의 지문을 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export const previewMime = "text/x-script.python";\n');
  violates(failure.run(), 'fingerprints');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'export const previewMime = "text/plain";\n');
  clean(pass.run());
});

test('canonical-redecl은 정본 모듈 export 이름의 재선언을 잡는다', () => {
  const module = 'export function badgeLabel(): string {\n  return "badge";\n}\n';
  const overrides = { canonicalModules: { 'packages/soul-ui/src/lib/badge_label.ts': ['soul-ui', 'app'] } };
  const failure = fixture(overrides);
  failure.write('packages/soul-ui/src/lib/badge_label.ts', module);
  failure.write('soul-app/src/index.ts', module);
  const result = failure.run();
  violates(result, 'canonical-redecl');
  assert.match(result.stdout, /soul-app\/src\/index\.ts:1 badgeLabel/);

  const pass = fixture(overrides);
  pass.write('packages/soul-ui/src/lib/badge_label.ts', module);
  pass.write('soul-app/src/index.ts', 'import { badgeLabel } from "../../packages/soul-ui/src/lib/badge_label";\nexport const label = badgeLabel;\n');
  clean(pass.run());
});

test('record-copy는 객체 판정과 값 사본을 시험 파일까지 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export function isPlainRecord(value: unknown): value is Record<string, unknown> {\n  return typeof value === "object" && value !== null;\n}\n');
  failure.write('orch-server-ts/tests/record.test.ts', 'function record(value: unknown) {\n  return value && typeof value === "object" ? value : undefined;\n}\n');
  const result = failure.run();
  violates(result, 'record-copy');
  assert.match(result.stdout, /orch-server-ts\/src\/index\.ts:1 isPlainRecord/);
  assert.match(result.stdout, /orch-server-ts\/tests\/record\.test\.ts:1 record/);

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'import { isRecord } from "@soulstream/wire-schema/json-record";\nexport const accepts = (value: unknown): boolean => isRecord(value);\n');
  pass.write('orch-server-ts/tests/record.test.ts', 'import { asRecord } from "@soulstream/wire-schema/json-record";\nexport const readId = (value: unknown): unknown => asRecord(value)?.id;\n');
  clean(pass.run());
});

test('reflect-key는 문자열 키를 잡고 변수 키는 통과한다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export const readSecret = (target: object): unknown => Reflect.get(target, "secret");\n');
  violates(failure.run(), 'reflect-key');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'export const readKey = (target: object, key: string): unknown => Reflect.get(target, key);\n');
  clean(pass.run());
});

test('renamed-reexport는 이름을 바꾼 재수출을 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export { alpha as beta } from "./other";\n');
  violates(failure.run(), 'renamed-reexport');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'export { alpha } from "./other";\n');
  clean(pass.run());
});

test('cross-identical은 패키지 쌍의 같은 이름과 본문을 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export const sharedValue = 42;\n');
  failure.write('soul-server-ts/src/index.ts', 'export const sharedValue = 42;\n');
  violates(failure.run(), 'cross-identical');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'export const sharedValue = 42;\n');
  pass.write('soul-server-ts/src/index.ts', 'export const sharedValue = 43;\n');
  clean(pass.run());
});

test('intra-identical은 같은 패키지의 같은 함수 본문을 잡는다', () => {
  const body = 'function prepare(value: string): string {\n  const trimmed = value.trim().toLowerCase();\n  const reversed = trimmed.split("").reverse().join("");\n  return reversed.length > 10 ? reversed.slice(0, 10) : reversed;\n}\n';
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', `import "./helper";\nexport ${body}`);
  failure.write('orch-server-ts/src/helper.ts', `export ${body}`);
  violates(failure.run(), 'intra-identical');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', `import "./helper";\nexport ${body}`);
  pass.write('orch-server-ts/src/helper.ts', `export ${body.replace('slice(0, 10)', 'slice(0, 20)')}`);
  clean(pass.run());
});

test('dead-module은 참조가 없는 모듈을 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/orphan.ts', 'export const orphanValue = 1;\n');
  violates(failure.run(), 'dead-module');

  const pass = fixture();
  pass.write('orch-server-ts/src/orphan.ts', 'export const orphanValue = 1;\n');
  pass.write('orch-server-ts/src/index.ts', 'import { orphanValue } from "./orphan";\nexport const value = orphanValue;\n');
  clean(pass.run());
});

test('single-state-machine은 전이 없는 상태 기계를 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export const machine = factory.createMachine({\n  states: { idle: {} },\n});\n');
  violates(failure.run(), 'single-state-machine');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'export const machine = factory.createMachine({\n  always: [],\n  states: { idle: {} },\n});\n');
  clean(pass.run());
});

test('runtime-cycle은 값 import 고리를 잡고 type import 고리는 통과한다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/zz_cycle_a.ts', 'import { zzCycleB } from "./zz_cycle_b";\nexport const zzCycleA = zzCycleB;\n');
  failure.write('orch-server-ts/src/zz_cycle_b.ts', 'import { zzCycleA } from "./zz_cycle_a";\nexport const zzCycleB = zzCycleA;\n');
  violates(failure.run(), 'runtime-cycle');

  const pass = fixture();
  pass.write('orch-server-ts/src/zz_cycle_a.ts', 'import type { ZzCycleB } from "./zz_cycle_b";\nexport const zzCycleA = (value: ZzCycleB): ZzCycleB => value;\n');
  pass.write('orch-server-ts/src/zz_cycle_b.ts', 'import { zzCycleA } from "./zz_cycle_a";\nexport type ZzCycleB = string;\nexport const zzCycleBValue = zzCycleA;\n');
  clean(pass.run());
});

test('cross-package-reexport는 다른 패키지에서 다시 내보내기를 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'export { isRecord } from "@soulstream/wire-schema/json-record";\n');
  violates(failure.run(), 'cross-package-reexport');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'export { alpha } from "./other";\n');
  clean(pass.run());
});

test('same-name-alias는 별칭을 원래 이름으로 다시 내놓기를 잡는다', () => {
  const failure = fixture();
  failure.write('orch-server-ts/src/index.ts', 'import { alpha as baseAlpha } from "./other";\nexport const alpha = baseAlpha;\n');
  violates(failure.run(), 'same-name-alias');

  const pass = fixture();
  pass.write('orch-server-ts/src/index.ts', 'import { alpha } from "./other";\nexport const beta = alpha;\n');
  clean(pass.run());
});

test('설정이 가리키는 파일이 없으면 종료 2로 끝난다', () => {
  const result = fixture({ canonicalModules: { 'orch-server-ts/src/http/missing_route_validation.ts': ['orch'] } }).run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('removed-client-name은 추적된 비 TS 파일의 옛 이름을 잡고 없으면 통과한다', () => {
  const word = 'kaleido' + 'scope';
  const failure = fixture();
  failure.write('tools/helper.py', `# uses ${word.toUpperCase()} client\n`);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: roots.at(-1) }).status, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: roots.at(-1) }).status, 0);
  const result = failure.run();
  violates(result, 'removed-client-name');
  assert.match(result.stdout, /^removed-client-name: tools\/helper\.py:1  → /m);

  const pass = fixture();
  pass.write('tools/helper.py', '# nothing here\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: roots.at(-1) }).status, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: roots.at(-1) }).status, 0);
  clean(pass.run());
});
