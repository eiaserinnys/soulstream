// CI 워크플로의 paths/paths-ignore 필터가 추적 파일을 가리키는지 검사한다.
//
// 사용법: node .github/scripts/check-ci-paths.mjs
// 종료 코드: 0 정상, 1 죽은 항목 있음, 2 읽을 수 없는 꼴이나 예외.
//
// 판정:
// - 맨 앞 !(부정)는 떼고 같은 규칙을 쓴다.
// - ?, +, [, ], {, }가 든 항목은 이 검사가 다루지 않는 글롭이라 2로 멈춘다.
// - *가 있으면 글롭이며 추적 파일 하나 이상이 path.posix.matchesGlob에 맞아야 한다.
// - *가 없으면 문자 그대로 경로이며 추적 파일과 정확히 같아야 한다.
// - run 블록의 시험 경로는 --dir·-C·--prefix·working-directory를 기준으로 푼다.
// - .easignore의 ! 항목은 추적 파일이나 디렉터리를 가리켜야 한다.
// - scripts/*.sh와 packages/*/scripts/*.sh에는 npx와 command -v 폴백이 없어야 한다.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNSUPPORTED_GLOB = /[?+\[\]{}]/;

export class UnsupportedFormError extends Error {
  constructor(filePath, line, detail) {
    super(detail);
    this.name = 'UnsupportedFormError';
    this.filePath = filePath;
    this.line = line;
  }
}

function badForm(filePath, line, detail) {
  return new UnsupportedFormError(filePath, line, detail);
}

function indentOf(line) {
  const match = /^ */.exec(line);
  return match[0].length;
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function stripTrailingComment(text) {
  return text.replace(/[ \t]+#.*$/, '').trim();
}

function unquoteKey(key) {
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
  if (key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1);
  return key;
}

function parseSingleQuoted(text, filePath, line) {
  let value = '';
  let index = 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      if (text[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      const tail = text.slice(index + 1).trim();
      if (tail !== '' && !tail.startsWith('#')) {
        throw badForm(filePath, line, '닫는 따옴표 뒤에 다른 값이 있습니다');
      }
      return value;
    }
    value += character;
    index += 1;
  }
  throw badForm(filePath, line, '작은따옴표가 닫히지 않았습니다');
}

function parseDoubleQuoted(text, filePath, line) {
  let value = '';
  let index = 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      if (index + 1 >= text.length) throw badForm(filePath, line, '큰따옴표 문자열의 이스케이프가 끝나지 않았습니다');
      value += text[index + 1];
      index += 2;
      continue;
    }
    if (character === '"') {
      const tail = text.slice(index + 1).trim();
      if (tail !== '' && !tail.startsWith('#')) {
        throw badForm(filePath, line, '닫는 따옴표 뒤에 다른 값이 있습니다');
      }
      return value;
    }
    value += character;
    index += 1;
  }
  throw badForm(filePath, line, '큰따옴표가 닫히지 않았습니다');
}

function parseScalar(text, filePath, line) {
  const value = text.trim();
  if (value === '') throw badForm(filePath, line, '목록 항목 값이 비어 있습니다');
  if (value.startsWith("'")) return parseSingleQuoted(value, filePath, line);
  if (value.startsWith('"')) return parseDoubleQuoted(value, filePath, line);
  const first = value[0];
  if ('*&|>{['.includes(first)) {
    throw badForm(filePath, line, `목록 항목이 '${first}'로 시작하는 꼴은 다루지 않습니다`);
  }
  const plain = stripTrailingComment(value);
  if (plain === '') throw badForm(filePath, line, '목록 항목 값이 비어 있습니다');
  if (/:(\s|$)/.test(plain)) throw badForm(filePath, line, '목록 항목이 매핑 꼴입니다');
  return plain;
}

// 워크플로 원문에서 paths/paths-ignore 블록을 읽는다.
// 읽을 수 없는 꼴을 만나면 UnsupportedFormError를 던진다.
export function parsePathFilters(source, filePath) {
  const lines = source.split(/\r?\n/);
  const onLine = lines.findIndex((line) => /^(?:on|'on'|"on")\s*:/.test(line));
  if (onLine === -1) return [];
  const onValue = stripTrailingComment(lines[onLine].replace(/^(?:on|'on'|"on")\s*:/, ''));
  if (onValue !== '') return [];

  let blockEnd = lines.length;
  for (let index = onLine + 1; index < lines.length; index += 1) {
    if (isIgnorable(lines[index])) continue;
    if (indentOf(lines[index]) === 0) {
      blockEnd = index;
      break;
    }
  }

  let eventIndent = Infinity;
  for (let index = onLine + 1; index < blockEnd; index += 1) {
    if (isIgnorable(lines[index])) continue;
    eventIndent = Math.min(eventIndent, indentOf(lines[index]));
  }
  if (eventIndent === Infinity) return [];

  const filters = [];
  let event = null;
  let index = onLine + 1;
  while (index < blockEnd) {
    const line = lines[index];
    if (isIgnorable(line)) {
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    const keyMatch = /^((?:[A-Za-z0-9_.-]+)|'[^']*'|"[^"]*")\s*:(.*)$/.exec(line.slice(indent));
    if (keyMatch === null) {
      index += 1;
      continue;
    }
    const key = unquoteKey(keyMatch[1]);
    if (indent === eventIndent) {
      event = key;
      index += 1;
      continue;
    }
    if (key !== 'paths' && key !== 'paths-ignore') {
      index += 1;
      continue;
    }
    const parsed = parseBlockList(lines, index, indent, filePath, event, key);
    filters.push(parsed.filter);
    index = parsed.next;
  }
  return filters;
}

function parseBlockList(lines, keyIndex, keyIndent, filePath, event, key) {
  const rest = stripTrailingComment(lines[keyIndex].slice(keyIndent).replace(/^[^:]*:/, ''));
  if (rest !== '') {
    throw badForm(filePath, keyIndex + 1, `${event}.${key} 값이 블록 목록이 아닙니다: ${rest}`);
  }

  const items = [];
  let itemIndent = null;
  let index = keyIndex + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const indent = indentOf(line);
    if (indent <= keyIndent) break;
    if (itemIndent === null) itemIndent = indent;
    if (indent !== itemIndent) {
      throw badForm(filePath, index + 1, `${event}.${key} 목록 항목의 들여쓰기가 다릅니다`);
    }
    const itemMatch = /^-(\s+(.*))?$/.exec(line.slice(indent));
    if (itemMatch === null) {
      throw badForm(filePath, index + 1, `${event}.${key} 목록 항목이 '- 값' 꼴이 아닙니다`);
    }
    items.push({ line: index + 1, raw: parseScalar(itemMatch[2] ?? '', filePath, index + 1) });
  }
  if (items.length === 0) {
    throw badForm(filePath, keyIndex + 1, `${event}.${key} 목록이 비어 있습니다`);
  }
  return { filter: { filePath, event, key, items }, next: index };
}

function matchesAnyTrackedFile(pattern, trackedFiles) {
  const starIndex = pattern.indexOf('*');
  const slashIndex = pattern.lastIndexOf('/', starIndex);
  const prefix = slashIndex === -1 ? '' : pattern.slice(0, slashIndex + 1);
  for (const file of trackedFiles) {
    if (prefix !== '' && !file.startsWith(prefix)) continue;
    if (posix.matchesGlob(file, pattern)) return true;
  }
  return false;
}

// 필터 항목과 추적 파일 목록을 대조해 죽은 항목을 돌려준다.
export function findDeadEntries(filters, trackedFileList) {
  const trackedFiles = trackedFileList instanceof Set ? trackedFileList : new Set(trackedFileList);
  const dead = [];
  for (const filter of filters) {
    for (const item of filter.items) {
      const pattern = item.raw.startsWith('!') ? item.raw.slice(1) : item.raw;
      if (UNSUPPORTED_GLOB.test(pattern)) {
        throw badForm(
          filter.filePath,
          item.line,
          `${filter.event}.${filter.key} 항목에 이 검사가 다루지 않는 글롭 문자가 있습니다: ${item.raw}`,
        );
      }
      const alive = pattern.includes('*')
        ? matchesAnyTrackedFile(pattern, trackedFiles)
        : trackedFiles.has(pattern);
      if (!alive) {
        dead.push({
          filePath: filter.filePath,
          line: item.line,
          event: filter.event,
          key: filter.key,
          raw: item.raw,
        });
      }
    }
  }
  return dead;
}

const TEST_COMMANDS = [
  ['vitest', 'run'],
  ['node', '--test'],
];

const SHELL_SCRIPT_PATH = /^(?:scripts\/[^/]+\.sh|packages\/[^/]+\/scripts\/[^/]+\.sh)$/;

function runArgumentStart(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (TEST_COMMANDS.some(([command, subcommand]) => tokens[index] === command && tokens[index + 1] === subcommand)) {
      return index + 2;
    }
    if (tokens[index] === 'pytest') return index + 1;
  }
  return -1;
}

function runBlockLines(lines, keyIndex, keyIndent) {
  const content = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      content.push({ line: index + 1, text: '' });
      continue;
    }
    if (indentOf(line) <= keyIndent) break;
    content.push({ line: index + 1, text: line.trim() });
  }
  return content;
}

function stepBaseDirectory(lines, runIndex, runIndent) {
  let start = runIndex;
  while (start > 0 && (lines[start - 1].trim() === '' || indentOf(lines[start - 1]) >= runIndent)) start -= 1;
  let end = runIndex;
  while (end + 1 < lines.length && (lines[end + 1].trim() === '' || indentOf(lines[end + 1]) >= runIndent)) end += 1;
  for (let index = start; index <= end; index += 1) {
    if (indentOf(lines[index]) !== runIndent) continue;
    const match = /^\s*working-directory:(.*)$/.exec(lines[index]);
    if (match !== null) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function parseRunBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:(.*)$/.exec(lines[index]);
    if (match === null) continue;
    const indent = match[1].length;
    const value = stripTrailingComment(match[2]);
    let content;
    if (value === '') {
      content = [{ line: index + 1, text: '' }];
    } else if (/^[|>][+-]?$/.test(value)) {
      content = runBlockLines(lines, index, indent);
      if (value.startsWith('>')) {
        content = [{ line: content[0]?.line ?? index + 1, text: content.map((entry) => entry.text).join(' ') }];
      }
    } else {
      content = [{ line: index + 1, text: match[2].trim() }];
    }
    blocks.push({ base: stepBaseDirectory(lines, index, indent), content });
  }
  return blocks;
}

function logicalCommands(content) {
  const commands = [];
  let current = null;
  for (const entry of content) {
    const text = entry.text.replace(/\s+$/, '');
    const continues = /[\\`]$/.test(text);
    if (current === null) current = { line: entry.line, text: '' };
    const piece = continues ? text.slice(0, -1) : text;
    current.text += `${current.text === '' ? '' : ' '}${piece}`;
    if (!continues) {
      commands.push(current);
      current = null;
    }
  }
  if (current !== null) commands.push(current);
  return commands;
}

function tokenize(text) {
  return text
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function resolveBase(tokens, stepBase) {
  let base = stepBase ?? '.';
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === '--dir' || tokens[index] === '-C' || tokens[index] === '--prefix') {
      base = posix.join(base, tokens[index + 1]);
    }
  }
  if (base.includes('$') || base.includes('*')) return null;
  return base;
}

function isTestPathToken(token) {
  const name = token.slice(token.lastIndexOf('/') + 1);
  if (!name.includes('.')) return false;
  return token.includes('tests/') || token.includes('.test.') || token.endsWith('.mjs') || token.endsWith('.py');
}

function findMissingRunPaths(source, filePath, trackedFiles) {
  const problems = [];
  let checked = 0;
  for (const block of parseRunBlocks(source)) {
    for (const command of logicalCommands(block.content)) {
      const tokens = tokenize(command.text);
      const start = runArgumentStart(tokens);
      if (start === -1) continue;
      const base = resolveBase(tokens, block.base);
      if (base === null) continue;
      let optionValue = false;
      for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.startsWith('-')) {
          optionValue = !token.includes('=');
          continue;
        }
        if (optionValue) {
          optionValue = false;
          continue;
        }
        if (!isTestPathToken(token)) continue;
        checked += 1;
        const resolved = posix.normalize(posix.join(base, token));
        const alive = token.includes('*')
          ? matchesAnyTrackedFile(resolved, trackedFiles)
          : trackedFiles.has(resolved);
        if (!alive) problems.push({ filePath, line: command.line, token });
      }
    }
  }
  return { checked, problems };
}

function findDeadIncludes(root, trackedFiles) {
  const filePath = join(root, '.easignore');
  if (!existsSync(filePath)) return { checked: 0, problems: [] };
  const problems = [];
  let checked = 0;
  readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const value = line.trim();
      if (!value.startsWith('!/')) return;
      checked += 1;
      const target = value.slice(2).replace(/\/$/, '');
      let alive = trackedFiles.has(target);
      if (!alive) {
        for (const file of trackedFiles) {
          if (file.startsWith(`${target}/`)) {
            alive = true;
            break;
          }
        }
      }
      if (!alive) problems.push({ line: index + 1, raw: value });
    });
  return { checked, problems };
}

function findScriptFallbacks(root, trackedFiles) {
  const problems = [];
  let checked = 0;
  for (const filePath of trackedFiles) {
    if (!SHELL_SCRIPT_PATH.test(filePath)) continue;
    checked += 1;
    readFileSync(join(root, filePath), 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        const text = line.trim();
        if (text.startsWith('#')) return;
        if (/\bnpx\s+(?!--no-install\b)/.test(text) || /command\s+-v\b[^|]*\|\|/.test(text)) {
          problems.push({ filePath, line: index + 1, text });
        }
      });
  }
  return { checked, problems };
}

export function checkRepository(root) {
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((entry) => entry !== '');
  const workflowsDir = join(root, '.github', 'workflows');
  const names = readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  const tracked = new Set(trackedFiles);
  const filters = [];
  const runProblems = [];
  let runChecked = 0;
  for (const name of names) {
    const filePath = posix.join('.github/workflows', name);
    const source = readFileSync(join(workflowsDir, name), 'utf8');
    filters.push(...parsePathFilters(source, filePath));
    const run = findMissingRunPaths(source, filePath, tracked);
    runChecked += run.checked;
    runProblems.push(...run.problems);
  }

  const dead = findDeadEntries(filters, trackedFiles);
  const includes = findDeadIncludes(root, tracked);
  const scripts = findScriptFallbacks(root, tracked);
  return {
    workflows: new Set(filters.map((filter) => filter.filePath)).size,
    items: filters.reduce((total, filter) => total + filter.items.length, 0),
    dead,
    runChecked,
    runProblems,
    includesChecked: includes.checked,
    includeProblems: includes.problems,
    scriptsChecked: scripts.checked,
    scriptProblems: scripts.problems,
  };
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const result = checkRepository(root);
  const lines = result.dead.map(
    (entry) => `${entry.filePath}:${entry.line} ${entry.event}.${entry.key} ${entry.raw}`,
  );
  if (result.dead.length > 0) {
    lines.push('가리키는 파일이 없습니다. 옮겼으면 새 경로로 고치고, 지웠으면 항목을 지웁니다.');
  }
  for (const entry of result.runProblems) {
    lines.push(
      `${entry.filePath}:${entry.line} ${entry.token} — 워크플로가 부르는 시험 파일이 없습니다. 경로를 고치거나 워크플로에서 지웁니다.`,
    );
  }
  for (const entry of result.includeProblems) {
    lines.push(`.easignore:${entry.line} ${entry.raw} — 가리키는 파일이나 디렉터리가 없습니다. 경로를 고치거나 항목을 지웁니다.`);
  }
  for (const entry of result.scriptProblems) {
    lines.push(
      `${entry.filePath}:${entry.line} ${entry.text} — 생성 스크립트에서 npx와 command -v 폴백을 쓰지 않습니다. 저장소에 설치한 도구를 직접 부릅니다.`,
    );
  }
  const problems =
    result.dead.length + result.runProblems.length + result.includeProblems.length + result.scriptProblems.length;
  lines.push(
    `워크플로 ${result.workflows}개, 항목 ${result.items}개, 죽은 항목 ${problems}개, 시험 경로 ${result.runChecked}개, .easignore 포함 ${result.includesChecked}개, 생성 스크립트 ${result.scriptsChecked}개`,
  );
  console.log(lines.join('\n'));
  process.exitCode = problems > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    if (error instanceof UnsupportedFormError) {
      console.error(`${error.filePath}:${error.line} ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    process.exitCode = 2;
  }
}
