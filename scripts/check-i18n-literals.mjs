import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(repo, 'packages/soul-ui/package.json'));
const ts = require('typescript');

function options(args) {
  const result = { root: repo, config: 'scripts/i18n-literal-check.config.json', mode: 'check' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' || arg === '--config') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${arg}에 경로가 필요합니다`);
      result[arg.slice(2)] = args[++i];
    } else if (arg === '--init' || arg === '--update') {
      if (result.mode !== 'check') throw Error('--init과 --update는 함께 쓸 수 없습니다');
      result.mode = arg.slice(2);
    } else throw Error(`알 수 없는 인자: ${arg}`);
  }
  result.root = resolve(result.root);
  return result;
}

function collect(root, roots) {
  const findings = {};
  function visitDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['__tests__', 'tests', 'test', 'e2e', 'qa'].includes(entry.name)) visitDirectory(file);
      } else if (entry.isFile() && ['.ts', '.tsx', '.js', '.jsx'].includes(extname(file)) && !/\.(?:test|spec|stories|qa)(?:[.-]|$)/.test(entry.name)) {
        const source = readFileSync(file, 'utf8');
        const lines = source.split(/\r?\n/);
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const name = relative(root, file).split(sep).join('/');
        function visit(node) {
          if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) && /[가-힣]/.test(node.text)) {
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
            if (!lines[line - 1].includes('i18n-ignore')) {
              (findings[name] ??= []).push({ line, text: lines[line - 1].trim() });
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(parsed);
      }
    }
  }
  for (const directory of roots) visitDirectory(resolve(root, directory));
  return findings;
}

function writeBaseline(path, counts) {
  writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
}

function main() {
  const { root, config: configPath, mode } = options(process.argv.slice(2));
  const config = JSON.parse(readFileSync(resolve(root, configPath), 'utf8'));
  const path = resolve(root, config.baseline);
  if (mode === 'init' && existsSync(path)) throw Error(`기준치 파일이 이미 있습니다: ${config.baseline}`);
  const baseline = mode === 'init' ? {} : JSON.parse(readFileSync(path, 'utf8'));
  const findings = collect(root, config.roots);
  const counts = Object.fromEntries(Object.entries(findings).map(([file, entries]) => [file, entries.length]));
  if (mode === 'init') { writeBaseline(path, counts); console.log(`기준치 생성: ${config.baseline}`); return 0; }
  if (mode === 'update') {
    const updated = Object.fromEntries(Object.entries(baseline).map(([file, count]) => [file, Math.min(count, counts[file] ?? 0)]));
    writeBaseline(path, updated); console.log(`기준치 감소분 반영: ${config.baseline}`); return 0;
  }
  let increased = false, decreased = false;
  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].sort()) {
    const old = baseline[file] ?? 0, current = counts[file] ?? 0;
    if (current > old) {
      increased = true;
      console.log(`${file}: 기준치 ${old}, 지금 ${current}`);
      for (const finding of findings[file]) console.log(`${file}:${finding.line}: ${finding.text}`);
    } else if (current < old) decreased = true;
  }
  if (decreased) console.log('기준치를 낮출 수 있다: node scripts/check-i18n-literals.mjs --update');
  if (!increased && !decreased) console.log('한글 문자열 기준치 통과');
  return increased ? 1 : 0;
}
try { process.exitCode = main(); }
catch (error) { console.error(`한글 문자열 검사 오류: ${error.message}`); process.exitCode = 2; }
