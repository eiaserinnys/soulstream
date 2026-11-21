/*
 * 소스 막이 검사. 리포 루트(현재 디렉터리)를 본다.
 * 사용법: node scripts/check-source-guards.mjs
 * 위반 한 건은 `<규칙>: <항목>  → <고치는 법>` 한 줄로 찍는다. 위반이 없으면 아무것도 찍지 않는다.
 * 종료 코드: 0 위반 없음, 1 위반 있음, 2 읽을 수 없는 입력(생성 index.ts 없음, 설정 JSON 오류).
 */

import { existsSync, opendirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

const root = process.cwd();
const files = new Map();
const listings = new Map();
let config;

function read(rel) {
  if (!files.has(rel)) {
    let text = '';
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      text = '';
    }
    files.set(rel, text);
  }
  return files.get(rel);
}

function walk(rel, extensions = ['.ts', '.tsx'], skipTests = true) {
  const key = `${rel}\u0000${extensions.join(',')}\u0000${skipTests}`;
  if (listings.has(key)) return listings.get(key);
  const base = join(root, rel);
  const found = [];
  if (existsSync(base)) {
    if (statSync(base).isFile()) {
      found.push(rel);
    } else {
      const visit = (dir) => {
        const directories = [];
        const handle = opendirSync(dir);
        try {
          let entry;
          while ((entry = handle.readSync()) !== null) {
            const child = join(dir, entry.name);
            if (entry.isDirectory()) {
              directories.push(child);
              continue;
            }
            if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
            if (entry.name.endsWith('.d.ts')) continue;
            const path = relative(root, child).split(sep).join('/');
            if (skipTests && (entry.name.includes('.test.') || path.includes('__tests__') || path.includes('/tests/') || path.includes('/e2e/'))) continue;
            found.push(path);
          }
        } finally {
          handle.closeSync();
        }
        for (const child of directories) visit(child);
      };
      visit(base);
    }
  }
  listings.set(key, found);
  return found;
}

function line(text, index) {
  return text.slice(0, index).split('\n').length;
}

function charCount(text) {
  return [...text].length;
}

function truncate(text, limit) {
  return [...text].slice(0, limit).join('');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capture(text, kind, start) {
  let depth = 0;
  let index = start;
  let started = false;
  let paren = 0;
  while (index < text.length && index - start < 10000) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      let close = text.indexOf(character, index + 1);
      while (close !== -1 && text[close - 1] === '\\') close = text.indexOf(character, close + 1);
      if (close === -1) return index;
      index = close + 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (kind === 'function' || kind === 'function*' || kind === 'class') {
      if (character === '(' && !started) {
        paren += 1;
      } else if (character === ')' && !started) {
        paren -= 1;
      } else if (character === '{' && paren === 0) {
        depth += 1;
        started = true;
      } else if (character === '}' && paren === 0) {
        depth -= 1;
        if (started && depth === 0) {
          let next = index + 1;
          while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next += 1;
          const nextCharacter = text[next];
          if (nextCharacter === '{' || nextCharacter === '|' || nextCharacter === '&' || nextCharacter === '[' || nextCharacter === '>') {
            started = false;
            index += 1;
            continue;
          }
          return index + 1;
        }
      }
    } else if (character === '{' || character === '(' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ')' || character === ']') {
      depth -= 1;
    } else if (character === ';' && depth === 0) {
      return index + 1;
    } else if (character === '\n' && depth === 0 && (kind === 'type' || kind === 'const' || kind === 'let') &&
               text[index + 1] !== undefined && !/\s/.test(text[index + 1]) && !'|&>)]}.?:'.includes(text[index + 1])) {
      return index;
    }
    index += 1;
  }
  return index;
}

function localNames(text) {
  return new Set([...text.matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)/gm)].map((match) => match[1]));
}

function platformBindings(text) {
  const names = new Set();
  for (const match of text.matchAll(/^[ \t]*import\s+(?:type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (/^(?:\.|@soulstream\/|@seosoyoung\/|@shared\/|@\/)/.test(match[2])) continue;
    const clause = match[1].replace(/\b\w+\s+as\s+(\w+)/g, '$1');
    for (const word of clause.match(/\b\w+\b/g) ?? []) {
      if (word !== 'type' && word !== 'as') names.add(word);
    }
  }
  return names;
}

function declarations(rel) {
  const exported = new Map();
  for (const file of walk(rel)) {
    if (file.includes('.type-test.')) continue;
    const text = read(file);
    const platform = platformBindings(text);
    const locals = localNames(text);
    for (const match of text.matchAll(/^export\s+(?:async\s+)?(function\*?|const|let|class|interface|type|enum)\s+(\w+)/gm)) {
      const kind = match[1];
      const name = match[2];
      const end = capture(text, kind === 'interface' || kind === 'enum' ? 'class' : kind, match.index + match[0].length);
      const raw = text.slice(match.index, end);
      if (kind === 'type' && /\btypeof\s+\w+/.test(raw)) continue;
      const after = raw.slice(match[0].length);
      if ([...locals].some((local) => local !== name && new RegExp(`\\b${escapeRegExp(local)}\\b`).test(after))) continue;
      const body = raw.replace(/\s+/g, '').replace(/'/g, '"');
      const bare = [...platform].some((binding) => new RegExp(`\\b${escapeRegExp(binding)}\\b`).test(after));
      exported.set(name, { file, body, line: line(text, match.index), bare });
    }
  }
  return exported;
}

function compareEntries(left, right) {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line < right.line ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return 0;
}

function wireCopies() {
  const names = new Set(
    [...read(config.generatedIndex).matchAll(/^export (?:interface|type) (\w+)/gm)].map((match) => match[1]),
  );
  const declaration = /^[ \t]*(?:export\s+)?(interface|type)\s+(\w+)(?:\s*<[^>]*>)?\s*(=\s*\{|\{|extends\b|=)/gm;
  const items = [];
  for (const packageRoot of Object.values(config.packages)) {
    for (const file of walk(packageRoot)) {
      const text = read(file);
      for (const match of text.matchAll(declaration)) {
        const [whole, kind, name, tail] = match;
        if (tail.startsWith('=') && /^\s*\[\s*\w+\s+in\b/.test(text.slice(match.index + whole.length))) continue;
        if (names.has(name) && (kind === 'interface' || tail.startsWith('= {') || tail === '{')) {
          items.push(`${file}:${line(text, match.index)} ${kind} ${name}  → @soulstream/wire-schema의 ${name}을 import하거나 파생으로 쓴다`);
        }
      }
    }
  }
  return items;
}

function sseAliasOnly() {
  const file = config.sseTypesFile;
  const text = read(file);
  const items = [];
  for (const match of text.matchAll(/^export (interface|type) (\w+)[^\n]*\{/gm)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('}', start);
    const body = text.slice(start, end === -1 ? -1 : end);
    if (/^\s*type:\s*["']/m.test(body)) {
      items.push(`${file}:${line(text, match.index)} ${match[2]}  → export type ${match[2]} = SSEEvent… 별칭으로 바꾸고 칸은 스키마에 둔다`);
    }
  }
  return items;
}

function sseSender() {
  const generated = read(config.generatedIndex);
  const match = /export const SSE_EVENT_TYPES = \[([\s\S]*?)\] as const/.exec(generated);
  const types = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]) : [];
  const corpus = config.sseSourcePackages
    .flatMap((packageName) => walk(config.packages[packageName], ['.ts', '.tsx'], false))
    .map((file) => read(file))
    .join('\n');
  const items = [];
  for (const type of types) {
    if (!new RegExp(`["'\`]${escapeRegExp(type)}["'\`]`).test(corpus)) {
      items.push(`upstream.schema.json SSEEvent "${type}"  → 보내는 자리가 없으면 def·durability·클라이언트 처리까지 지운다`);
    }
  }
  return items;
}

function fingerprints() {
  const items = [];
  for (const fingerprint of config.fingerprints) {
    const pattern = new RegExp(fingerprint.pattern, 'gm');
    for (const packageRoot of Object.values(config.packages)) {
      for (const file of walk(packageRoot)) {
        if (fingerprint.canonical.includes(file)) continue;
        const text = read(file);
        for (const match of text.matchAll(pattern)) {
          items.push(`${file}:${line(text, match.index)} ${fingerprint.label}  → ${fingerprint.hint}`);
        }
      }
    }
  }
  return items;
}

function canonicalRedecl() {
  const items = [];
  for (const [packageName, modules] of Object.entries(config.canonicalModules)) {
    const packageRoot = config.packages[packageName];
    const canonical = new Map();
    for (const module of modules) {
      for (const match of read(`${packageRoot}/${module}`).matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+(\w+)/gm)) {
        canonical.set(match[1], module);
      }
    }
    for (const file of walk(packageRoot)) {
      if (modules.includes(file.slice(packageRoot.length + 1))) continue;
      const text = read(file);
      for (const match of text.matchAll(/^[ \t]*(export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)\s*[(<]|(?:const|let|var)\s+(\w+)\s*[=:<]|class\s+(\w+)\b|interface\s+(\w+)\s*(?:<|\{|extends)|type\s+(\w+)\s*(?:<|=)|enum\s+(\w+))/gm)) {
        const name = match.slice(2).find((group) => group);
        if (canonical.has(name)) {
          items.push(`${file}:${line(text, match.index)} ${name}  → ${canonical.get(name)}의 ${name}을 import하거나 다른 이름을 쓴다`);
        }
      }
    }
  }
  return items;
}

function renamedReexport() {
  const items = [];
  for (const packageName of config.reexportPackages) {
    for (const file of walk(config.packages[packageName])) {
      const text = read(file);
      for (const match of text.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*\bas\b[^}]*)\}\s*from\s*["'](\.[^"']+)["']/gm)) {
        const names = truncate(match[1].trim().replace(/\s+/g, ' '), 60);
        items.push(`${file}:${line(text, match.index)} ${names}  → 호출처가 원래 이름을 import한다`);
      }
      for (const match of text.matchAll(/^[ \t]*export\s*\{([^}]*\bas\b[^}]*)\};?[ \t]*$/gm)) {
        if (match[1].includes('as default')) continue;
        const names = truncate(match[1].trim().replace(/\s+/g, ' '), 60);
        items.push(`${file}:${line(text, match.index)} ${names}  → 호출처가 원래 이름을 import한다`);
      }
    }
  }
  return items;
}

function crossIdentical() {
  const exported = {};
  for (const packageName of config.crossPackages) exported[packageName] = declarations(config.packages[packageName]);
  const items = [];
  for (const [leftPackage, rightPackage] of config.packagePairs) {
    const left = exported[leftPackage];
    const right = exported[rightPackage];
    const shared = [...left.keys()].filter((name) => right.has(name)).sort();
    for (const name of shared) {
      const leftEntry = left.get(name);
      const rightEntry = right.get(name);
      if ((leftPackage === 'app' || rightPackage === 'app') && (leftEntry.bare || rightEntry.bare)) continue;
      if (leftEntry.body === rightEntry.body) {
        items.push(`${leftEntry.file}:${leftEntry.line} = ${rightEntry.file}:${rightEntry.line} : ${name} (${charCount(leftEntry.body)}자)  → 공유 패키지 한 곳에 두고 양쪽이 import한다`);
      }
    }
  }
  return items;
}

function intraIdentical() {
  const items = [];
  for (const packageName of config.intraPackages) {
    const groups = new Map();
    for (const file of walk(config.packages[packageName])) {
      const text = read(file);
      for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(/gm)) {
        const open = match.index + match[0].length - 1;
        const end = capture(text, 'function', open);
        const body = text.slice(open, end).replace(/\s+/g, '').replace(/'/g, '"');
        if (charCount(body) < 150) continue;
        const entries = groups.get(body) ?? [];
        entries.push({ file, line: line(text, match.index), name: match[1] });
        groups.set(body, entries);
      }
    }
    for (const [body, entries] of groups) {
      if (entries.length < 2) continue;
      const sorted = [...entries].sort(compareEntries);
      const first = sorted[0];
      for (const entry of sorted.slice(1)) {
        items.push(`${entry.file}:${entry.line} ${entry.name} = ${first.file}:${first.line} ${first.name} (${charCount(body)}자)  → 한 곳에 두고 import한다`);
      }
    }
  }
  return items;
}

function deadModule() {
  const settings = config.deadModule;
  const packageRoots = Object.values(config.packages);
  const collect = (directories, extensions, skipTests) => {
    const counts = new Map();
    const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const directory of directories) {
      for (const file of walk(directory, extensions, skipTests)) {
        const text = read(file);
        for (const match of text.matchAll(/(?:from|import|require\()\s*\(?\s*["']([^"']+)["']/g)) {
          bump(match[1].split('/').pop().replace(/\.(js|ts|tsx|mjs|cjs)$/, ''));
        }
        for (const match of text.matchAll(/[\w./-]+\/([\w.-]+)\.(?:ts|tsx|js)\b/g)) {
          bump(match[1].replace(/\.(js|ts|tsx)$/, ''));
        }
        if (file.endsWith('.cjs') || file.endsWith('.mjs') || file.endsWith('.js')) {
          for (const match of text.matchAll(/["']([\w-]+)\.(?:ts|tsx)["']/g)) bump(match[1]);
        }
      }
    }
    return counts;
  };
  const production = collect([...packageRoots, ...settings.extra], settings.extensions, true);
  const tests = collect([...packageRoots, ...settings.testDirectories], settings.testExtensions, false);
  for (const match of read(settings.wireSchemaPackage).matchAll(/"\.\/([\w-]+)":\s*"\.\/src\/([\w]+)\.ts"/g)) {
    production.set(match[2], (production.get(match[2]) ?? 0) + (production.get(match[1]) ?? 0));
    tests.set(match[2], (tests.get(match[2]) ?? 0) + (tests.get(match[1]) ?? 0));
  }
  const allow = new RegExp(settings.allow);
  const items = [];
  for (const packageName of settings.packages) {
    for (const file of walk(config.packages[packageName])) {
      if (allow.test(file)) continue;
      const base = basename(file).replace(/\.(ts|tsx)$/, '');
      if ((production.get(base) ?? 0) === 0) {
        const hint = (tests.get(base) ?? 0) > 0 ? '시험만 참조한다. 구현과 시험을 함께 지운다' : 'import하는 곳이 없다. 지우거나 호출처를 잇는다';
        items.push(`${file}  → ${hint}`);
      }
    }
  }
  return items;
}

function singleStateMachine() {
  const items = [];
  for (const packageName of config.stateMachinePackages) {
    for (const file of walk(config.packages[packageName])) {
      const text = read(file);
      if (text.includes('.createMachine(') && !/\b(target|always)\b/.test(text) && (text.match(/\bstates\s*:/g) ?? []).length <= 2) {
        items.push(`${file}  → 전이가 없는 기계는 판정 함수(if 사슬)로 바꾼다`);
      }
    }
  }
  return items;
}

function main() {
  config = JSON.parse(readFileSync(join(root, 'scripts', 'source-guards.config.json'), 'utf8'));
  if (!existsSync(join(root, config.generatedIndex))) {
    throw new Error(`생성 타입 파일을 읽을 수 없습니다: ${config.generatedIndex}`);
  }
  const rules = [
    ['canonical-redecl', canonicalRedecl],
    ['cross-identical', crossIdentical],
    ['dead-module', deadModule],
    ['fingerprints', fingerprints],
    ['intra-identical', intraIdentical],
    ['renamed-reexport', renamedReexport],
    ['single-state-machine', singleStateMachine],
    ['sse-alias-only', sseAliasOnly],
    ['sse-sender', sseSender],
    ['wire-copies', wireCopies],
  ];
  let violations = 0;
  for (const [name, check] of rules) {
    for (const item of check()) {
      console.log(`${name}: ${item}`);
      violations += 1;
    }
  }
  return violations === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`소스 막이 검사 오류: ${error.message}`);
  process.exitCode = 2;
}
