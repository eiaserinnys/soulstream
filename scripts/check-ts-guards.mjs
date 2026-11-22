import { createRequire } from 'node:module';
import path from 'node:path';

function main() {
  const configs = process.argv.slice(2);
  if (configs.length === 0) throw new Error('사용법: node scripts/check-ts-guards.mjs <tsconfig>...');
  const findings = new Map();
  for (const config of configs) {
    const configPath = path.resolve(config);
    const require = createRequire(path.join(path.dirname(configPath), 'package.json'));
    const ts = require('typescript');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) throw new Error(`${config}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length) throw new Error(`${config}: ${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, ' ')}`);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
    const checker = program.getTypeChecker();
    for (const sourceFile of program.getSourceFiles()) {
      const filename = sourceFile.fileName.replaceAll('\\', '/');
      if (sourceFile.isDeclarationFile || filename.includes('/node_modules/') || !/\.(ts|tsx|mts|cts)$/.test(filename)) continue;
      const file = path.relative(process.cwd(), sourceFile.fileName).replaceAll('\\', '/');
      if (filename.endsWith('.ts')) {
        const shadowed = `${sourceFile.fileName}x`;
        if (ts.sys.fileExists(shadowed) && !program.getSourceFile(shadowed)) {
          const shadowedFile = path.relative(process.cwd(), shadowed).replaceAll('\\', '/');
          const rule = 'shadowed-source';
          const detail = `같은 폴더의 ${path.basename(sourceFile.fileName)}에 가려 형 검사에서 빠진다  → 한쪽 이름을 바꾼다`;
          findings.set(`${rule}\0${shadowedFile}`, { rule, file: shadowedFile, line: 1, position: 0, text: `${rule}: ${shadowedFile}:1 ${detail}` });
        }
      }
      const record = (rule, node, detail, identity) => {
        const position = node.getStart(sourceFile);
        const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
        const key = `${rule}\0${file}\0${identity}`;
        findings.set(key, { rule, file, line, position, text: `${rule}: ${file}:${line} ${detail}` });
      };
      const imports = new Map();
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) continue;
        const module = statement.moduleSpecifier.text;
        const list = imports.get(module) ?? [];
        list.push(statement);
        imports.set(module, list);
      }
      for (const [module, list] of imports) {
        if (list.length > 1) record('duplicate-import', list[1], `"${module}" ${list.length}문  → 한 import 문으로 합친다(형은 이름 앞에 type)`, module);
      }
      const visit = (node) => {
        const isOmit = (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Omit')
          || (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Omit');
        if (isOmit && node.typeArguments?.length === 2) {
          const target = checker.getTypeFromTypeNode(node.typeArguments[0]);
          if ((target.flags & ts.TypeFlags.TypeParameter) === 0 && checker.getIndexInfosOfType(target).some((info) => (info.keyType.flags & ts.TypeFlags.String) !== 0)) {
            record('omit-index', node, `${node.getText(sourceFile).replace(/\s+/g, ' ')}  → 키를 다시 매기는 매핑형으로 쓴다`, node.getStart(sourceFile));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  const sorted = [...findings.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line || a.position - b.position);
  for (const finding of sorted) console.log(finding.text);
  return sorted.length ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`TypeScript 막이 검사 오류: ${error.message.replace(/\s+/g, ' ')}`);
  process.exitCode = 2;
}
