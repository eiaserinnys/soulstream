/*
 * 소스 막이 검사. 리포 루트(현재 디렉터리)를 본다.
 * 사용법: node scripts/check-source-guards.mjs
 * 위반 한 건은 `<규칙>: <항목>  → <고치는 법>` 한 줄로 찍는다. 위반이 없으면 아무것도 찍지 않는다.
 * 종료 코드: 0 위반 없음, 1 위반 있음, 2 읽을 수 없는 입력(생성 index.ts 없음, 설정 JSON 오류).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, opendirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';

const root = process.cwd();
const files = new Map();
const listings = new Map();
let config;

function read(rel) {
  if (!files.has(rel)) files.set(rel, readFileSync(join(root, rel), 'utf8'));
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
  for (const [module, packages] of Object.entries(config.canonicalModules)) {
    const names = new Set([...read(module).matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+(\w+)/gm)].map((match) => match[1]));
    for (const packageName of packages) {
      for (const file of walk(config.packages[packageName])) {
        if (file === module) continue;
        const text = read(file);
        for (const match of text.matchAll(/^[ \t]*(export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)\s*[(<]|(?:const|let|var)\s+(\w+)\s*[=:<]|class\s+(\w+)\b|interface\s+(\w+)\s*(?:<|\{|extends)|type\s+(\w+)\s*(?:<|=)|enum\s+(\w+))/gm)) {
          const name = match.slice(2).find((group) => group);
          if (names.has(name)) items.push(`${file}:${line(text, match.index)} ${name}  → ${module}의 ${name}을 import하거나 다른 이름을 쓴다`);
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

function commentStripped(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (match) => '\n'.repeat((match.match(/\n/g) ?? []).length));
  return stripped.replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function packageAt(rel) {
  let path = posix.normalize(rel);
  while (path && path !== '.') {
    if (existsSync(join(root, path, 'package.json'))) {
      return { dir: path, name: JSON.parse(read(`${path}/package.json`)).name ?? '' };
    }
    path = posix.dirname(path);
    if (path === '.') path = '';
  }
  throw new Error(`${rel}: package.json을 찾지 못함`);
}

function crossesPackage(spec, file, pkgDir, pkgName, ownPackage) {
  if (spec.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(file), spec));
    return !(target === pkgDir || target.startsWith(`${pkgDir}/`));
  }
  if (config.packageScopes.some((scope) => spec.startsWith(scope))) {
    return spec.split('/').slice(0, 2).join('/') !== pkgName;
  }
  for (const [prefix, owner] of Object.entries(config.packageAliases)) {
    if (spec.startsWith(prefix)) return owner !== ownPackage;
  }
  return false;
}

function importBindings(clause) {
  const match = /\{([\s\S]*)\}/.exec(clause);
  if (!match) return [];
  const found = [];
  for (const part of match[1].split(',')) {
    const cleaned = part.trim().replace(/^type\s+/, '');
    if (!cleaned) continue;
    const split = /\s+as\s+/.exec(cleaned);
    if (split) {
      found.push([cleaned.slice(0, split.index).trim(), cleaned.slice(split.index + split[0].length).trim()]);
    } else {
      found.push([cleaned, cleaned]);
    }
  }
  return found;
}

function crossPackageReexport() {
  const items = [];
  for (const packageName of config.reexportPackages) {
    const packageRoot = config.packages[packageName];
    const pkg = packageAt(packageRoot);
    for (const file of walk(packageRoot)) {
      const text = commentStripped(read(file));
      for (const match of text.matchAll(/^[ \t]*export\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm)) {
        if (!crossesPackage(match[2], file, pkg.dir, pkg.name, packageName)) continue;
        const names = truncate(match[1].replace(/\s+/g, ' ').trim(), 80);
        items.push(`${file}:${line(text, match.index)} ${match[2]} ${names}  → 쓰는 곳이 ${match[2]}에서 바로 가져온다`);
      }
      const imported = new Map();
      for (const match of text.matchAll(/^[ \t]*import\s+(?:type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
        if (!crossesPackage(match[2], file, pkg.dir, pkg.name, packageName)) continue;
        for (const [orig, alias] of importBindings(match[1])) imported.set(alias, [orig, match[2]]);
      }
      for (const match of text.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm)) {
        for (const [orig] of importBindings(`{${match[1]}}`)) {
          if (!imported.has(orig)) continue;
          const spec = imported.get(orig)[1];
          items.push(`${file}:${line(text, match.index)} ${spec} ${orig}  → 쓰는 곳이 ${spec}에서 바로 가져온다`);
        }
      }
    }
  }
  return items;
}

function sameNameAlias() {
  const items = [];
  for (const packageName of config.reexportPackages) {
    for (const file of walk(config.packages[packageName])) {
      const text = commentStripped(read(file));
      const imported = new Map();
      for (const match of text.matchAll(/^[ \t]*import\s+(?:type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
        for (const [orig, alias] of importBindings(match[1])) imported.set(alias, [orig, match[2]]);
      }
      for (const [alias, [orig, spec]] of imported) {
        if (alias === orig) continue;
        const pattern = new RegExp(`^[ \\t]*export\\s+(?:declare\\s+)?(?:type|const|let|var)\\s+${escapeRegExp(orig)}\\s*(?:<[^=;]*>)?\\s*=\\s*${escapeRegExp(alias)}\\b\\s*(?:<[^;]*>)?\\s*;?[ \\t]*$`, 'gm');
        for (const match of text.matchAll(pattern)) {
          items.push(`${file}:${line(text, match.index)} ${orig} = ${alias} (${spec})  → 별칭 없이 가져오고, 쓰는 곳은 원래 자리에서 가져온다`);
        }
      }
    }
  }
  return items;
}

function resolveImport(fileSet, importer, spec) {
  const target = posix.normalize(posix.join(posix.dirname(importer), spec));
  const candidates = [];
  if (target.endsWith('.js')) candidates.push(`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`);
  candidates.push(target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`);
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function stronglyConnected(edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  for (const rootNode of edges.keys()) {
    if (index.has(rootNode)) continue;
    index.set(rootNode, counter);
    low.set(rootNode, counter);
    counter += 1;
    stack.push(rootNode);
    onStack.add(rootNode);
    const work = [{ node: rootNode, children: [...edges.get(rootNode)].sort().values() }];
    while (work.length) {
      const frame = work[work.length - 1];
      const node = frame.node;
      let descended = false;
      for (let next = frame.children.next(); !next.done; next = frame.children.next()) {
        const child = next.value;
        if (!edges.has(child)) continue;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, children: [...edges.get(child)].sort().values() });
          descended = true;
          break;
        }
        if (onStack.has(child)) low.set(node, Math.min(low.get(node), index.get(child)));
      }
      if (descended) continue;
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        for (;;) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === node) break;
        }
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components;
}

function runtimeCycle() {
  const items = [];
  for (const packageName of config.cyclePackages) {
    const packageRoot = config.packages[packageName];
    const listed = walk(packageRoot);
    const fileSet = new Set(listed);
    const edges = new Map();
    for (const file of listed) {
      const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const targets = new Set();
      for (const match of text.matchAll(/(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["'](\.[^"']*)["']|import\s*["'](\.[^"']*)["']/gs)) {
        if (match[4]) {
          if (match[2]) continue;
          const clause = match[3].trim();
          if (clause.startsWith('{') && clause.endsWith('}')) {
            const names = clause.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean);
            if (names.length && names.every((part) => part.startsWith('type '))) continue;
          }
          const target = resolveImport(fileSet, file, match[4]);
          if (target) targets.add(target);
        } else {
          const target = resolveImport(fileSet, file, match[5]);
          if (target) targets.add(target);
        }
      }
      edges.set(file, targets);
    }
    for (const component of stronglyConnected(edges)) {
      items.push(`${component.join(' ')}  → 한쪽 선언을 다른 모듈로 옮겨 런타임 import 고리를 끊는다`);
    }
  }
  return items.sort();
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

const recordId = '[A-Za-z_$][\\w$]*';
const recordReturn = '(?::\\s*(\\{[^{}]*\\}[^{;=]*?|[^{;=]+?))?';
const recordHeads = [
  new RegExp(`^[ \\t]*(?:export\\s+)?function\\s+(${recordId})\\s*\\(\\s*(${recordId})\\s*:\\s*unknown\\s*,?\\s*\\)\\s*${recordReturn}\\s*\\{`, 'gm'),
  new RegExp(`^[ \\t]*(?:(?:private|protected|public|static|readonly)\\s+)*(${recordId})\\s*\\(\\s*(${recordId})\\s*:\\s*unknown\\s*,?\\s*\\)\\s*${recordReturn}\\s*\\{`, 'gm'),
  new RegExp(`^[ \\t]*(?:export\\s+)?const\\s+(${recordId})\\s*=\\s*\\(\\s*(${recordId})\\s*:\\s*unknown\\s*,?\\s*\\)\\s*${recordReturn}\\s*=>\\s*`, 'gm'),
];
const guardHeads = [
  new RegExp(`^[ \\t]*(?:export\\s+)?function\\s+(${recordId})\\s*\\(\\s*(${recordId})\\s*:\\s*unknown\\s*,?\\s*\\)\\s*:\\s*(${recordId})\\s+is\\s+(\\{[^{}]*\\}|[^{]+?)\\s*\\{`, 'gm'),
  new RegExp(`^[ \\t]*(?:export\\s+)?const\\s+(${recordId})\\s*=\\s*\\(\\s*(${recordId})\\s*:\\s*unknown\\s*,?\\s*\\)\\s*:\\s*(${recordId})\\s+is\\s+([\\s\\S]+?)\\s*=>\\s*`, 'gm'),
];
const recordKeywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);

function recordScan(text, start, stop) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
    } else if ('"\'`'.includes(ch)) quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth < 0) return i;
    }
    if (depth === 0 && !quote && stop(text, i)) return i;
  }
  return text.length;
}

function recordBlock(text, start) {
  return text.slice(start + 1, recordScan(text, start + 1, () => false));
}

function recordStrip(expr) {
  expr = expr.trim();
  while (expr.startsWith('(') && expr.endsWith(')')) {
    if (recordScan(expr, 1, () => false) !== expr.length - 1) break;
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

function guardStrip(expr) {
  expr = expr.trim();
  while (expr.startsWith('(') && expr.endsWith(')')) {
    let depth = 0;
    let whole = true;
    for (let i = 0; i < expr.length; i += 1) {
      if (expr[i] === '(') depth += 1;
      if (expr[i] === ')') depth -= 1;
      if (depth === 0 && i < expr.length - 1) { whole = false; break; }
    }
    if (!whole) break;
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

function recordSplit(expr, op) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let last = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
    } else if ('"\'`'.includes(ch)) quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(last, i));
      i += op.length - 1;
      last = i + 1;
    }
  }
  parts.push(expr.slice(last));
  return parts.map((part) => recordStrip(part).replace(/\s+/g, ' '));
}

function recordTernary(expr) {
  let q = null;
  let depth = 0;
  let quote = null;
  let nested = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
    } else if ('"\'`'.includes(ch)) quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (depth === 0 && ch === '?') {
      const next = expr[i + 1];
      if (next === '?' || (next === '.' && !/\d/.test(expr[i + 2] ?? ''))) { i += 1; continue; }
      if (q === null) { q = i; nested = 0; } else nested += 1;
    } else if (depth === 0 && ch === ':' && q !== null) {
      if (nested === 0) return [expr.slice(0, q), expr.slice(q + 1, i), expr.slice(i + 1)];
      nested -= 1;
    }
  }
  return null;
}

function fullMatch(pattern, text) {
  return new RegExp(`^(?:${pattern})$`).test(text);
}

function unwrapBoolean(expr, strip) {
  expr = strip(expr);
  if (expr.startsWith('Boolean(')) {
    const inner = expr.slice('Boolean'.length);
    const stripped = strip(inner);
    if (stripped !== inner) expr = stripped;
  }
  return expr;
}

function guardCopy(param, expr) {
  expr = unwrapBoolean(expr, guardStrip);
  const p = escapeRegExp(param);
  if (fullMatch(`isRecord\\(\\s*${p}\\s*\\)`, expr)) return true;
  const type = [`typeof ${p} === ("object"|'object')`, `("object"|'object') === typeof ${p}`];
  const allowed = [...type, `${p} !== null`, `null !== ${p}`, `${p} != null`, `!!${p}`, p, `Boolean\\(${p}\\)`, `!Array\\.isArray\\(${p}\\)`];
  const terms = expr.split('&&').map((term) => guardStrip(term).replace(/\s+/g, ' '));
  return type.some((pattern) => terms.some((term) => fullMatch(pattern, term))) && terms.every((term) => allowed.some((pattern) => fullMatch(pattern, term)));
}

function recordCondition(param, expr, positive) {
  expr = positive ? unwrapBoolean(expr, recordStrip) : recordStrip(expr);
  const p = escapeRegExp(param);
  if (fullMatch(`${positive ? '' : '!\\s*'}isRecord\\(\\s*${p}\\s*\\)`, expr)) return true;
  const op = positive ? '===?' : '!==?';
  const type = [`typeof ${p} ${op} ("object"|'object')`, `("object"|'object') ${op} typeof ${p}`];
  const allowed = positive
    ? [...type, `!Array\\.isArray\\(${p}\\)`, `${p} !==? (null|undefined)`, `(null|undefined) !==? ${p}`, `!!${p}`, p, `Boolean\\(${p}\\)`]
    : [...type, `Array\\.isArray\\(${p}\\)`, `${p} ===? (null|undefined)`, `(null|undefined) ===? ${p}`, `!${p}`];
  const terms = recordSplit(expr, positive ? '&&' : '||');
  return type.some((pattern) => terms.some((term) => fullMatch(pattern, term))) && terms.every((term) => allowed.some((pattern) => fullMatch(pattern, term)));
}

function recordDefault(expr) {
  return ['null', 'undefined', '{}'].includes(recordStrip(expr).replace(/\s+/g, ''));
}

function recordValue(param, expr) {
  expr = recordStrip(expr);
  return expr === param || fullMatch(`${escapeRegExp(param)}\\s+as\\s+[\\s\\S]+`, expr);
}

function recordReturned(stmt) {
  stmt = stmt.trim();
  const block = /^\{\s*([\s\S]*?)\s*\}$/.exec(stmt);
  if (block) stmt = block[1].trim();
  return /^return\s+([\s\S]+?)\s*;?$/.exec(stmt)?.[1] ?? null;
}

function recordIfReturn(body) {
  const match = /^\s*if\s*\(/.exec(body);
  if (!match) return null;
  const close = recordScan(body, match[0].length, () => false);
  const condition = body.slice(match[0].length, close);
  const rest = body.slice(close + 1).trim();
  const end = rest.startsWith('{') ? recordScan(rest, 1, () => false) : recordScan(rest, 0, (text, i) => text[i] === ';');
  const first = recordReturned(rest.slice(0, end + 1));
  const second = recordReturned(rest.slice(end + 1));
  return first === null || second === null ? null : [condition, first, second];
}

function recordCopyValue(param, body, expression = false) {
  let expr = expression ? body.trim().replace(/;+$/, '').trim() : recordReturned(body);
  if (expr !== null) {
    expr = recordStrip(expr);
    const match = new RegExp(`^asRecord\\(\\s*${escapeRegExp(param)}\\s*\\)(?:\\s*\\?\\?\\s*([\\s\\S]+))?$`).exec(expr);
    if (match && (match[1] === undefined || recordDefault(match[1]))) return true;
    const parts = recordTernary(expr);
    return !!parts && recordDefault(parts[2]) && recordValue(param, parts[1]) && recordCondition(param, parts[0], true);
  }
  const parts = recordIfReturn(body);
  if (!parts) return false;
  return (recordDefault(parts[1]) && recordValue(param, parts[2]) && recordCondition(param, parts[0], false)) ||
    (recordDefault(parts[2]) && recordValue(param, parts[1]) && recordCondition(param, parts[0], true));
}

function recordCopies() {
  const items = [];
  for (const sourceRoot of config.codeRoots) {
    for (const file of walk(sourceRoot, ['.ts', '.tsx'], false)) {
      if (file === config.recordCanonical) continue;
      const text = read(file);
      const found = new Map();
      for (const [index, regex] of guardHeads.entries()) {
        for (const match of text.matchAll(regex)) {
          const [, name, param, predParam, predType] = match;
          if (param !== predParam || predType.includes('[]')) continue;
          const rest = text.slice(match.index + match[0].length);
          let body;
          if (index === 0 || rest.startsWith('{')) {
            const source = index === 0 ? text.slice(match.index + match[0].length - 1) : rest;
            let depth = 0;
            let end = 0;
            for (; end < source.length; end += 1) {
              if (source[end] === '{') depth += 1;
              if (source[end] === '}' && --depth === 0) break;
            }
            body = source.slice(1, end);
            const result = /^\s*return\s+([\s\S]+?);?\s*$/.exec(body);
            body = result?.[1];
          } else body = rest.split(';', 1)[0];
          if (body && guardCopy(param, body)) found.set(`${match.index}:${name}`, [match.index, name]);
        }
      }
      const seen = new Set();
      for (const [index, regex] of recordHeads.entries()) {
        for (const match of text.matchAll(regex)) {
          const [, name, param] = match;
          if (index < 2 && (recordKeywords.has(name) || seen.has(match.index))) continue;
          if (index < 2) seen.add(match.index);
          const rest = text.slice(match.index + match[0].length);
          const block = index < 2 ? text.slice(match.index + match[0].length - 1) : rest;
          const expression = index === 2 && !rest.startsWith('{');
          const body = expression ? rest.slice(0, recordScan(rest, 0, (source, i) => source[i] === ';')) : recordBlock(block, 0);
          if (recordCopyValue(param, body, expression)) found.set(`${match.index}:${name}`, [match.index, name]);
        }
      }
      for (const [index, name] of found.values()) items.push(`${file}:${line(text, index)} ${name}  → ${config.recordCanonical}의 isRecord나 asRecord를 가져다 쓴다`);
    }
  }
  return items;
}

function reflectKey() {
  const items = [];
  for (const sourceRoot of config.codeRoots) {
    for (const file of walk(sourceRoot, ['.ts', '.tsx'], false)) {
      const text = read(file);
      for (const match of text.matchAll(/\bReflect\.(get|set|has)\s*\(/g)) {
        const start = match.index + match[0].length;
        const comma = recordScan(text, start, (source, i) => source[i] === ',');
        const rest = text.slice(comma + 1);
        const key = /^\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*(?=[,)])/s.exec(rest);
        if (!key || (key[1] === '`' && key[2].includes('${'))) continue;
        items.push(`${file}:${line(text, match.index)} Reflect.${match[1]} "${key[2]}"  → obj["${key[2]}"]나 "${key[2]}" in obj로 바로 쓴다`);
      }
    }
  }
  return items;
}

// 옛 클라이언트 이름 금지. 예전 CI의 `git grep -i -n` 단계와 같은 대상(추적 파일 전체, 대소문자 무시, 확장자 제한 없음)이다.
// 낱말을 통째로 적으면 이 파일이 스스로 걸리므로 쪼개 잇는다. git 작업 트리가 아니면(시험 fixture) 건너뛴다.
function removedClientName() {
  if (!existsSync(join(root, '.git'))) return [];
  const forbidden = 'kaleido' + 'scope';
  const result = spawnSync('git', ['grep', '-i', '-n', '-e', forbidden], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`git grep 실패(종료 ${result.status}): ${result.stderr.trim()}`);
  const fix = '추적 파일에서 옛 클라이언트 이름을 지운다';
  return result.stdout.split('\n').filter(Boolean).map((out) => {
    const match = /^(.+?):(\d+):/.exec(out);
    return `${match ? `${match[1]}:${match[2]}` : out}  → ${fix}`;
  });
}

function main() {
  config = JSON.parse(readFileSync(join(root, 'scripts', 'source-guards.config.json'), 'utf8'));
  const rules = [
    ['canonical-redecl', canonicalRedecl],
    ['cross-identical', crossIdentical],
    ['cross-package-reexport', crossPackageReexport],
    ['dead-module', deadModule],
    ['fingerprints', fingerprints],
    ['intra-identical', intraIdentical],
    ['record-copy', recordCopies],
    ['reflect-key', reflectKey],
    ['removed-client-name', removedClientName],
    ['renamed-reexport', renamedReexport],
    ['runtime-cycle', runtimeCycle],
    ['same-name-alias', sameNameAlias],
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
