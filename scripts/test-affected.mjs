// 사용법: node scripts/test-affected.mjs [--base <ref>] [--list]
// 종료 코드: 0 통과, 1 시험 실패, 2 입력 오류.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decidePostgresTests, isPostgresTestFile } from '../packages/db-schema/scripts/postgres-test-policy.mjs';

const TEST_FILE = /\.test\.(?:ts|tsx|mts|mjs|js)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);
const URL_LITERAL = /new URL\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`)\s*,\s*import\.meta\.url\s*\)/g;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

class InputError extends Error {}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new InputError(`git ${args.join(' ')} 실패: ${result.stderr.trim()}`);
  return result.stdout;
}

function parseArgs(argv) {
  const options = { base: 'origin/main', list: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--list') options.list = true;
    else if (argv[index] === '--base' && argv[index + 1]) options.base = argv[++index];
    else throw new InputError('사용법: node scripts/test-affected.mjs [--base <ref>] [--list]');
  }
  return options;
}

function repositoryRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) throw new InputError('git 저장소 안에서 부른다');
  return path.resolve(result.stdout.trim());
}

function changedFiles(root, base) {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const split = (output) => output.split('\0').filter(Boolean);
  const names = [
    ...split(git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase])),
    ...split(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ];
  return [...new Set(names)].sort().map((name) => path.join(root, name));
}

function workspaceDirectories(root) {
  const lines = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const patterns = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const item = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
      if (item) patterns.push(item[1]);
    }
  }
  const directories = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(path.join(parent, entry.name));
      }
    } else {
      directories.push(path.join(root, pattern));
    }
  }
  return directories.filter((directory) => existsSync(path.join(directory, 'package.json'))).sort();
}

function vitestPackages(root) {
  return workspaceDirectories(root).filter((directory) => {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return Boolean(manifest.dependencies?.vitest || manifest.devDependencies?.vitest);
  });
}

function testFilesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...testFilesUnder(full));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readSources(root, testFile) {
  const sources = [];
  const text = readFileSync(testFile, 'utf8');
  for (const match of text.matchAll(URL_LITERAL)) {
    const literal = match[1] ?? match[2] ?? match[3];
    if (ABSOLUTE_URL.test(literal)) continue;
    const target = path.resolve(fileURLToPath(new URL(literal, pathToFileURL(testFile))));
    const isDirectory = literal.endsWith('/') || (existsSync(target) && statSync(target).isDirectory());
    if (isDirectory) {
      const relative = path.relative(root, target);
      const depth = relative === '' ? 0 : relative.split(path.sep).length;
      if (relative.startsWith('..') || depth <= 1) continue;
    }
    sources.push({ target, isDirectory });
  }
  return sources;
}

function readerMatches(root, packages, changed) {
  const matches = [];
  for (const directory of packages) {
    for (const testFile of testFilesUnder(directory)) {
      for (const { target, isDirectory } of readSources(root, testFile)) {
        for (const file of changed) {
          if (file === target || (isDirectory && isWithin(target, file))) matches.push({ directory, testFile, file });
        }
      }
    }
  }
  return matches;
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function vitestArguments(files) {
  return ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', '--minWorkers=1', '--maxWorkers=2', ...files];
}

function plan(root, base) {
  const changed = changedFiles(root, base);
  const existing = changed.filter((file) => existsSync(file));
  const packages = vitestPackages(root);
  const matches = readerMatches(root, packages, changed);
  const postgres = decidePostgresTests();
  const addedTests = new Map(packages.map((directory) => [directory, new Set()]));
  const deferred = new Set();
  for (const { directory, testFile } of matches) {
    if (postgres.excludePostgres && isPostgresTestFile(testFile)) deferred.add(testFile);
    else addedTests.get(directory).add(testFile);
  }
  const runs = packages.map((directory) => ({
    directory,
    files: [...new Set([...existing, ...addedTests.get(directory)])],
  }));
  return { changed, packages, matches, postgres, deferred: [...deferred].sort(), runs };
}

function printPlan(root, { changed, matches, postgres, deferred, runs }) {
  if (changed.length === 0) console.log('바뀐 파일이 없다');
  for (const file of changed) console.log(`changed ${rel(root, file)}`);
  for (const { testFile, file } of matches) console.log(`reads ${rel(root, testFile)} <- ${rel(root, file)}`);
  console.log(`postgres excludePostgres=${postgres.excludePostgres} backendAvailable=${postgres.backendAvailable}`);
  if (postgres.excludePostgres) {
    console.log('postgres 시험은 이 노드에 시험 DB가 없어 CI에서만 돈다' + (deferred.length > 0 ? ':' : ''));
    for (const file of deferred) console.log(`  ${rel(root, file)}`);
  }
  for (const { directory, files } of runs) {
    console.log(`package ${rel(root, directory)}: corepack ${vitestArguments(files.map((file) => rel(root, file))).join(' ')}`);
  }
}

function runAll(root, { runs }) {
  const results = [];
  for (const { directory, files } of runs) {
    if (files.length === 0) continue;
    console.log(`\n== ${rel(root, directory)} ==`);
    const result = spawnSync('corepack', vitestArguments(files), { cwd: directory, stdio: 'inherit' });
    results.push({ name: rel(root, directory), code: result.status ?? 1 });
  }
  console.log('\n패키지별 결과');
  for (const { name, code } of results) console.log(`  ${name}: ${code}`);
  return results.every(({ code }) => code === 0) ? 0 : 1;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = repositoryRoot();
  const result = plan(root, options.base);
  printPlan(root, result);
  if (options.list || result.changed.length === 0) return 0;
  return runAll(root, result);
}

try {
  process.exitCode = main();
} catch (error) {
  if (!(error instanceof InputError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
