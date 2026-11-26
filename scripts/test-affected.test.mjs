import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const script = fileURLToPath(new URL('./test-affected.mjs', import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readerTest(literal) {
  return `import { readFileSync } from 'node:fs';\nreadFileSync(new URL(${literal}, import.meta.url));\n`;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'test-affected-'));
  roots.push(root);
  const write = (path, contents = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-m', message);
  };
  const list = (...args) => spawnSync(process.execPath, [script, '--list', ...args], { cwd: root, encoding: 'utf8' });

  git('init', '-b', 'main');
  write('pnpm-workspace.yaml', "packages:\n  - 'pkg-a'\n  - 'libs/*'\n");
  const vitestPackage = (name) => JSON.stringify({ name, devDependencies: { vitest: '^2.1.9' } });
  write('pkg-a/package.json', vitestPackage('pkg-a'));
  write('libs/pkg-b/package.json', vitestPackage('pkg-b'));
  write('libs/plain/package.json', JSON.stringify({ name: 'plain' }));
  write('pkg-a/src/a.ts');
  write('pkg-a/src/sub/b.ts');
  write('pkg-a/src/old.ts');
  write('pkg-a/tests/file.test.ts', readerTest('"../src/a.ts"'));
  write('pkg-a/tests/folder.test.ts', readerTest('"../src/"'));
  write('libs/pkg-b/tests/root.test.ts', readerTest('"../../../"'));
  write('libs/pkg-b/tests/one-below-root.test.ts', readerTest('"../../"'));
  commit('initial');
  write('pkg-a/src/old.ts', '// before the merge-base\n');
  commit('before merge-base');
  git('checkout', '-b', 'feature');
  git('checkout', 'main');
  write('pkg-a/src/main-only.ts');
  commit('main moved on');
  git('checkout', 'feature');
  return { root, write, git, commit, list };
}

function readsOf(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('reads ')).map((line) => line.slice('reads '.length));
}

function changedOf(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('changed ')).map((line) => line.slice('changed '.length));
}

test('원본을 파일로 읽는 시험은 그 원본을 고치면 대조 결과에 나오고 저장소 뿌리를 읽는 시험은 나오지 않는다', () => {
  const repo = repository();
  repo.write('pkg-a/src/a.ts', '// edited\n');
  repo.write('pkg-a/src/sub/b.ts', '// edited\n');
  const result = repo.list('--base', 'main');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readsOf(result.stdout).sort(), [
    'pkg-a/tests/file.test.ts <- pkg-a/src/a.ts',
    'pkg-a/tests/folder.test.ts <- pkg-a/src/a.ts',
    'pkg-a/tests/folder.test.ts <- pkg-a/src/sub/b.ts',
  ]);
  assert.doesNotMatch(result.stdout, /root\.test\.ts|one-below-root\.test\.ts/);
});

test('바뀐 파일은 base와의 merge-base부터 커밋, 수정, 미추적 파일을 모두 센다', () => {
  const repo = repository();
  repo.write('pkg-a/src/committed.ts');
  repo.commit('feature commit');
  repo.write('pkg-a/src/a.ts', '// uncommitted edit\n');
  repo.write('pkg-a/src/untracked.ts');
  const result = repo.list('--base', 'main');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(changedOf(result.stdout).sort(), [
    'pkg-a/src/a.ts',
    'pkg-a/src/committed.ts',
    'pkg-a/src/untracked.ts',
  ]);
});

test('vitest가 있는 패키지만 돌릴 명령에 오른다', () => {
  const repo = repository();
  repo.write('pkg-a/src/a.ts', '// edited\n');
  const result = repo.list('--base', 'main');
  assert.match(result.stdout, /^package pkg-a: .*vitest related --run --passWithNoTests/m);
  assert.match(result.stdout, /^package libs\/pkg-b: /m);
  assert.doesNotMatch(result.stdout, /libs\/plain/);
});

test('바뀐 파일이 없으면 돌릴 명령이 없고 0으로 끝난다', () => {
  const repo = repository();
  const result = spawnSync(process.execPath, [script, '--base', 'main'], { cwd: repo.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /바뀐 파일이 없다/);
});

test('없는 base는 입력 오류로 2로 끝난다', () => {
  const repo = repository();
  const result = repo.list('--base', 'no-such-ref');
  assert.equal(result.status, 2, result.stdout + result.stderr);
});
