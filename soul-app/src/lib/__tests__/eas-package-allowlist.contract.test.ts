import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../../../../');
const appSourceRoot = path.join(repoRoot, 'soul-app', 'src');
const packagesRoot = path.join(repoRoot, 'packages');

test('every shared package source imported by soul-app is allowed by .easignore', () => {
  const pending = sourceFilesUnder(appSourceRoot);
  const scanned = new Set<string>();
  const packageFiles = new Set<string>();

  while (pending.length > 0) {
    const importer = pending.pop()!;
    if (scanned.has(importer)) continue;
    scanned.add(importer);

    for (const specifier of moduleSpecifiers(importer)) {
      const importedFile = resolveRelativePackageImport(importer, specifier);
      if (!importedFile) continue;
      packageFiles.add(relativePosix(repoRoot, importedFile));
      if (!scanned.has(importedFile)) pending.push(importedFile);
    }
  }

  const allowedLines = new Set(
    fs.readFileSync(path.join(repoRoot, '.easignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim()),
  );
  assertPackageFilesAllowed(packageFiles, allowedLines);
});

test('skips type-only imports and re-exports', () => {
  const importer = path.join(appSourceRoot, 'lib', '__tests__', 'fixture.ts');
  const packageSpecifier = path.relative(
    path.dirname(importer),
    path.join(packagesRoot, 'wire-schema', 'src', 'persistent_jev_candidates.ts'),
  ).split(path.sep).join('/');
  const sourceText = [
    `import type { PersistentJevCandidatesDebugEvent } from '${packageSpecifier}';`,
    `export type { PersistentJevCandidatesDebugEvent } from '${packageSpecifier}';`,
  ].join('\n');

  expect(moduleSpecifiers(importer, sourceText)).toEqual([]);
});

test('value imports still fail when their package source has no allowlist entry', () => {
  const importer = path.join(appSourceRoot, 'lib', '__tests__', 'fixture.ts');
  const packageSource = path.join(packagesRoot, 'wire-schema', 'src', 'persistent_jev_candidates.ts');
  const packageSpecifier = path.relative(path.dirname(importer), packageSource)
    .split(path.sep).join('/');
  const sourceText = `import { isPersistentJevCandidatesDebugEvent } from '${packageSpecifier}';`;
  const importedFiles = moduleSpecifiers(importer, sourceText)
    .map((specifier) => resolveRelativePackageImport(importer, specifier))
    .filter((file): file is string => file !== null)
    .map((file) => relativePosix(repoRoot, file));

  expect(importedFiles).toEqual(['packages/wire-schema/src/persistent_jev_candidates.ts']);
  expect(() => assertPackageFilesAllowed(new Set(importedFiles), new Set())).toThrow(
    'Missing packages/wire-schema/src/persistent_jev_candidates.ts; add !/packages/wire-schema/src/persistent_jev_candidates.ts',
  );
});

function sourceFilesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function moduleSpecifiers(filePath: string, sourceText = fs.readFileSync(filePath, 'utf8')): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: string[] = [];

  const addStringLiteral = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) result.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return result;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  return clause?.isTypeOnly === true || (
    clause?.name === undefined
    && clause?.namedBindings !== undefined
    && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  return node.isTypeOnly || (
    node.exportClause !== undefined
    && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function assertPackageFilesAllowed(packageFiles: Iterable<string>, allowedLines: ReadonlySet<string>): void {
  const missing = [...packageFiles]
    .filter((file) => !allowedLines.has(`!/${file}`))
    .sort();
  if (missing.length > 0) {
    throw new Error(missing.map((file) => `Missing ${file}; add !/${file}`).join('\n'));
  }
}

function resolveRelativePackageImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const basePath = path.resolve(path.dirname(importer), specifier);
  if (!isWithin(packagesRoot, basePath)) return null;

  const candidates = path.extname(basePath)
    ? [basePath]
    : [
      `${basePath}.ts`,
      `${basePath}.tsx`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
    ];
  const importedFile = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!importedFile) {
    throw new Error(
      `${relativePosix(repoRoot, importer)} imports ${specifier}, but no .ts or .tsx source exists under packages`,
    );
  }
  return importedFile;
}

function isWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}
