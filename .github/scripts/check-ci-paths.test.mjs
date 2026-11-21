import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePathFilters } from './check-ci-paths.mjs';

const scriptPath = fileURLToPath(new URL('./check-ci-paths.mjs', import.meta.url));

function makeRepository(files, workflow) {
  const root = mkdtempSync(join(tmpdir(), 'check-ci-paths-'));
  writeFileSync(join(root, '.easignore'), '');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'probe.yml'), workflow);
  const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
}

function workflowWithPaths(items) {
  return ['name: Probe', 'on:', '  pull_request:', '    paths:', ...items.map((item) => `      - ${item}`)].join('\n');
}

function withRepository(files, workflow, run) {
  const root = makeRepository(files, workflow);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('죽은 paths 항목을 행 번호와 함께 찍고 1로 끝난다', () => {
  withRepository(
    { 'a.txt': 'a', 'b/c.ts': 'c' },
    workflowWithPaths([
      "'soul-server-ts/src/runner/sqlite_intervention_inbox.ts'",
      "'nope/**'",
      "'!gone/file.ts'",
      "'b/*.ts'",
    ]),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, result.stderr);
      for (const expected of [
        '.github/workflows/probe.yml:5 pull_request.paths soul-server-ts/src/runner/sqlite_intervention_inbox.ts',
        '.github/workflows/probe.yml:6 pull_request.paths nope/**',
        '.github/workflows/probe.yml:7 pull_request.paths !gone/file.ts',
      ]) {
        assert.ok(result.stdout.includes(expected), result.stdout);
      }
      assert.ok(result.stdout.includes('가리키는 파일이 없습니다'), result.stdout);
      assert.ok(result.stdout.includes('워크플로 1개, 항목 4개, 죽은 항목 3개'), result.stdout);
    },
  );
});

test('모든 항목이 실재하면 0으로 끝난다', () => {
  withRepository({ 'a.txt': 'a', 'b/c.ts': 'c' }, workflowWithPaths(["'a.txt'", "'b/*.ts'", "'!b/c.ts'"]), (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('죽은 항목 0개'), result.stdout);
  });
});

test('흐름 꼴 paths 값은 2로 끝난다', () => {
  withRepository({ 'a.txt': 'a' }, ['on:', '  pull_request:', "    paths: ['a.txt']"].join('\n'), (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(result.stderr.includes('probe.yml:3'), result.stderr);
  });
});

test('다루지 않는 글롭 문자 ?가 있으면 2로 끝난다', () => {
  withRepository({ 'a.txt': 'a' }, workflowWithPaths(["'a?.txt'"]), (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(result.stderr.includes('probe.yml:5'), result.stderr);
  });
});

test('워크플로가 부르는 시험 파일이 없으면 1로 끝난다', () => {
  withRepository(
    { 'pkg/tests/live.test.mjs': '' },
    [
      'name: Probe',
      'on:',
      '  push:',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Run tests',
      '        working-directory: pkg',
      '        run: node --test tests/gone.test.mjs',
    ].join('\n'),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('.github/workflows/probe.yml:10 tests/gone.test.mjs'), result.stdout);
    },
  );
});

test('워크플로가 부르는 시험 파일과 글롭이 실재하면 0으로 끝난다', () => {
  withRepository(
    { 'pkg/tests/live.test.mjs': '', 'portable-node/tests/one.test.mjs': '' },
    [
      'name: Probe',
      'on:',
      '  push:',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Run tests',
      '        run: node --test pkg/tests/live.test.mjs "portable-node/tests/*.test.mjs"',
    ].join('\n'),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('시험 경로 2개'), result.stdout);
    },
  );
});

test('.easignore가 없는 파일을 포함하면 1로 끝난다', () => {
  withRepository(
    {
      'packages/soul-ui/src/lib/kept.ts': '',
      '.easignore': '!/packages/soul-ui/src/lib/kept.ts\n!/packages/soul-ui/src/lib/gone.ts\n',
    },
    workflowWithPaths(["'packages/soul-ui/src/lib/kept.ts'"]),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('.easignore:2 !/packages/soul-ui/src/lib/gone.ts'), result.stdout);
    },
  );
});

test('.easignore의 포함 항목이 파일과 디렉터리를 가리키면 0으로 끝난다', () => {
  withRepository(
    {
      'packages/soul-ui/src/lib/kept.ts': '',
      '.easignore': '!/packages\n!/packages/soul-ui\n!/packages/soul-ui/src/lib/kept.ts\n',
    },
    workflowWithPaths(["'packages/soul-ui/src/lib/kept.ts'"]),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('.easignore 포함 3개'), result.stdout);
    },
  );
});

test('생성 스크립트의 npx와 command -v 폴백을 잡는다', () => {
  withRepository(
    {
      'packages/wire-schema/scripts/generate.sh': '#!/usr/bin/env bash\nnpx json2ts --help\ncommand -v json2ts || exit 1\n',
    },
    workflowWithPaths(["'packages/wire-schema/scripts/generate.sh'"]),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(
        result.stdout.includes('packages/wire-schema/scripts/generate.sh:2 npx json2ts --help'),
        result.stdout,
      );
      assert.ok(
        result.stdout.includes('packages/wire-schema/scripts/generate.sh:3 command -v json2ts || exit 1'),
        result.stdout,
      );
    },
  );
});

test('설치된 도구를 직접 부르는 생성 스크립트는 0으로 끝난다', () => {
  withRepository(
    {
      'packages/wire-schema/scripts/generate.sh':
        '#!/usr/bin/env bash\n"$HERE/node_modules/.bin/json2ts" --input x\nnpx --no-install tsc --noEmit\n',
      'scripts/check.sh': '#!/usr/bin/env bash\necho ok\n',
    },
    workflowWithPaths(["'packages/wire-schema/scripts/generate.sh'"]),
    (root) => {
      const result = runChecker(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('생성 스크립트 2개'), result.stdout);
    },
  );
});

test('따옴표 세 꼴과 목록 사이 주석을 읽는다', () => {
  const filters = parsePathFilters(
    [
      'name: Probe',
      'on:',
      '  push:',
      '    paths:',
      "      - 'a.txt'",
      '      # 목록 사이 주석',
      '',
      '      - "b.txt"',
      '      - plain.txt',
      '  pull_request:',
      '    paths-ignore:',
      '      - ignored/**',
    ].join('\n'),
    '.github/workflows/probe.yml',
  );

  assert.deepEqual(
    filters.map((filter) => `${filter.event}.${filter.key}`),
    ['push.paths', 'pull_request.paths-ignore'],
  );
  assert.deepEqual(
    filters[0].items.map((item) => item.raw),
    ['a.txt', 'b.txt', 'plain.txt'],
  );
  assert.deepEqual(
    filters[0].items.map((item) => item.line),
    [5, 8, 9],
  );
  assert.deepEqual(
    filters[1].items.map((item) => item.raw),
    ['ignored/**'],
  );
});
