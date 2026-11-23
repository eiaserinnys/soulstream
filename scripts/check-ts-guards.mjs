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
      const isConstant = (input) => {
        let node = input;
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
        if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
        if (ts.isPrefixUnaryExpression(node)) {
          return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(node.operator) && isConstant(node.operand);
        }
        if (ts.isBinaryExpression(node)) {
          const operator = node.operatorToken.kind;
          return !(operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) && isConstant(node.left) && isConstant(node.right);
        }
        if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) && isConstant(element));
        if (ts.isObjectLiteralExpression(node)) {
          return node.properties.every((property) => ts.isPropertyAssignment(property)
            && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) && isConstant(property.initializer));
        }
        return false;
      };
      const identifiers = new Map();
      const mocks = [];
      const constants = [];
      const expects = [];
      const unwrap = (input) => {
        let node = input;
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
          || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
        return node;
      };
      const unstableSelectorResult = (input) => {
        const node = unwrap(input);
        if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return true;
        if (ts.isConditionalExpression(node)) return unstableSelectorResult(node.whenTrue) || unstableSelectorResult(node.whenFalse);
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
          return unstableSelectorResult(node.left) || unstableSelectorResult(node.right);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Map', 'Set', 'Date'].includes(node.expression.text)) return true;
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
        const { expression, name } = node.expression;
        if (ts.isIdentifier(expression) && ((expression.text === 'Object' && ['keys', 'values', 'entries'].includes(name.text))
          || (expression.text === 'Array' && name.text === 'from'))) return true;
        return ['map', 'filter', 'slice', 'concat', 'flat', 'flatMap', 'toSorted', 'toReversed'].includes(name.text);
      };
      const selectorReturnsUnstable = (selector) => {
        if (!ts.isBlock(selector.body)) return unstableSelectorResult(selector.body);
        let unstable = false;
        const visitReturn = (node) => {
          if (ts.isFunctionLike(node)) return;
          if (ts.isReturnStatement(node) && node.expression && unstableSelectorResult(node.expression)) unstable = true;
          if (!unstable) ts.forEachChild(node, visitReturn);
        };
        ts.forEachChild(selector.body, visitReturn);
        return unstable;
      };
      const visit = (node) => {
        if (ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)) {
          const query = node.expression.expression;
          if (ts.isTaggedTemplateExpression(query)
            && ((ts.isIdentifier(query.tag) && query.tag.text === 'sql')
              || (ts.isPropertyAccessExpression(query.tag) && query.tag.name.text === 'sql'))) {
            const template = query.template;
            const head = ts.isNoSubstitutionTemplateLiteral(template) ? template.text : template.head.text;
            const sql = ts.isNoSubstitutionTemplateLiteral(template) ? head : [head, ...template.templateSpans.map((span) => span.literal.text)].join(' ');
            const start = head.replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '');
            if (/^SELECT\b/i.test(start) && /\bFROM\b/i.test(sql)
              && !/\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(sql)
              && !/\bFROM\s+[a-zA-Z_][\w."]*\s*\(/i.test(sql)
              && !/\b(?:pg_advisory_\w*|setval|set_config|pg_notify)\s*\(/i.test(sql)) {
              record('discarded-select-query', node, 'SELECT 결과를 사용하거나 불필요한 조회를 지운다', node.getStart(sourceFile));
            }
          }
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
          const selector = node.arguments[0];
          if (/^use[A-Z]\w*Store$/.test(name) && selector
            && (ts.isArrowFunction(selector) || ts.isFunctionExpression(selector)) && selectorReturnsUnstable(selector)) {
            record('unstable-zustand-selector', node, '새 참조를 반환하는 선택자를 useShallow로 감싸거나 안정된 값을 반환한다', node.getStart(sourceFile));
          }
        }
        const isOmit = (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Omit')
          || (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Omit');
        if (isOmit && node.typeArguments?.length === 2) {
          const target = checker.getTypeFromTypeNode(node.typeArguments[0]);
          if ((target.flags & ts.TypeFlags.TypeParameter) === 0 && checker.getIndexInfosOfType(target).some((info) => (info.keyType.flags & ts.TypeFlags.String) !== 0)) {
            record('omit-index', node, `${node.getText(sourceFile).replace(/\s+/g, ' ')}  → 키를 다시 매기는 매핑형으로 쓴다`, node.getStart(sourceFile));
          }
        }
        if (ts.isIdentifier(node)) {
          const list = identifiers.get(node.text) ?? [];
          list.push(node);
          identifiers.set(node.text, list);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)
          && !node.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          const init = node.initializer;
          if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && ts.isIdentifier(init.expression.expression)
            && ['vi', 'jest'].includes(init.expression.expression.text) && init.expression.name.text === 'fn') mocks.push(node);
          if ((node.parent.flags & ts.NodeFlags.Const) !== 0 && isConstant(init)) constants.push(node);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect' && node.arguments.length) expects.push(node);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      const referencesOf = (declaration) => {
        const symbol = checker.getSymbolAtLocation(declaration.name);
        return (identifiers.get(declaration.name.text) ?? []).filter((id) => id !== declaration.name
          && (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
            ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id)) === symbol);
      };
      const isExpectSubject = (id) => ts.isCallExpression(id.parent) && ts.isIdentifier(id.parent.expression)
        && id.parent.expression.text === 'expect' && id.parent.arguments[0] === id;
      for (const mock of mocks) {
        if (referencesOf(mock).every((id) => (ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id) || isExpectSubject(id))) {
          record('unwired-mock', mock.name, `${mock.name.text}  → 넘기는 곳이 없는 목이다. 목과 그 단언을 지운다`, mock.name.getStart(sourceFile));
        }
      }
      for (const call of expects) {
        let current = call;
        while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current && ['not', 'resolves', 'rejects'].includes(current.parent.name.text)) current = current.parent;
        const access = current.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== current) continue;
        const matcher = access.parent;
        if (!ts.isCallExpression(matcher) || matcher.expression !== access || !matcher.arguments.every(isConstant)) continue;
        const subject = call.arguments[0];
        const declaration = ts.isIdentifier(subject) && constants.find((candidate) => candidate.name.text === subject.text
          && checker.getSymbolAtLocation(candidate.name) === checker.getSymbolAtLocation(subject));
        if (isConstant(subject) || (declaration && referencesOf(declaration).every(isExpectSubject))) {
          record('constant-expect', call, `${call.getText(sourceFile).replace(/\s+/g, ' ')}  → 상수끼리 견주는 단언을 지운다`, call.getStart(sourceFile));
        }
      }
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
