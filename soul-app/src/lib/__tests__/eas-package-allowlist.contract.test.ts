import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../../../../');
const appSourceRoot = path.join(repoRoot, 'soul-app', 'src');
const appEntryFile = path.join(repoRoot, 'soul-app', 'App.tsx');
const packagesRoot = path.join(repoRoot, 'packages');
const chatUiRoot = path.join(packagesRoot, 'chat-ui');
const chatUiSourceFiles = [
  'canonical.ts',
  'controller.ts',
  'evaluate.ts',
  'index.ts',
  'text.ts',
  'types.ts',
  'validate.ts',
  'validate_structure.ts',
  'validate_utils.ts',
];

type PackageClosure = {
  packageFiles: Set<string>;
  packageNameImports: Array<{ file: string; specifier: string }>;
};

let valueImportClosure: PackageClosure | null = null;
let typeImportClosure: PackageClosure | null = null;

function packageClosure(includeTypeOnly: boolean): PackageClosure {
  if (includeTypeOnly) {
    typeImportClosure ??= collectPackageClosure(true);
    return typeImportClosure;
  }
  valueImportClosure ??= collectPackageClosure(false);
  return valueImportClosure;
}

function collectPackageClosure(includeTypeOnly: boolean): PackageClosure {
  const pending = [...sourceFilesUnder(appSourceRoot), appEntryFile];
  const scanned = new Set<string>();
  const packageFiles = new Set<string>();
  const packageNameImports: Array<{ file: string; specifier: string }> = [];

  while (pending.length > 0) {
    const importer = pending.pop()!;
    if (scanned.has(importer)) continue;
    scanned.add(importer);
    const importerPath = relativePosix(repoRoot, importer);

    for (const specifier of moduleSpecifiers(importer, undefined, includeTypeOnly)) {
      if (
        importerPath.startsWith('packages/')
        && (specifier.startsWith('@soulstream/') || specifier.startsWith('@seosoyoung/'))
      ) {
        packageNameImports.push({ file: importerPath, specifier });
      }

      const packageImport = resolvePackageNameImport(importer, specifier);
      if (packageImport) {
        packageFiles.add(relativePosix(repoRoot, packageImport.manifestPath));
        packageFiles.add(relativePosix(repoRoot, packageImport.entryPath));
        pending.push(packageImport.entryPath);
        continue;
      }

      const importedFile = resolveRelativePackageImport(importer, specifier);
      if (!importedFile) continue;
      packageFiles.add(relativePosix(repoRoot, importedFile));
      if (!scanned.has(importedFile)) pending.push(importedFile);
    }
  }

  return { packageFiles, packageNameImports };
}

test('every shared package source imported by soul-app is allowed by .easignore', () => {
  const { packageFiles } = packageClosure(false);

  const allowedLines = new Set(
    fs.readFileSync(path.join(repoRoot, '.easignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim()),
  );
  assertPackageFilesAllowed(packageFiles, allowedLines);

  expect([...packageFiles]
    .filter((file) => file.startsWith('packages/chat-ui/'))
    .sort()).toEqual([
    'packages/chat-ui/package.json',
    ...chatUiSourceFiles.map((file) => `packages/chat-ui/src/${file}`),
  ].sort());
  for (const parent of ['packages', 'packages/chat-ui', 'packages/chat-ui/src']) {
    expect(allowedLines.has(`!/${parent}`)).toBe(true);
  }
});

test('every shared package source imported by soul-app is inside the metro watch folders', () => {
  const watchFolders: string[] = require(
    path.join(repoRoot, 'soul-app', 'scripts', 'shared-source-folders.cjs'),
  );
  const watchFoldersRelative = watchFolders.map((folder) => relativePosix(repoRoot, folder));
  const outside = [...packageClosure(false).packageFiles]
    .filter((file) => !watchFoldersRelative.some(
      (folder) => file === folder || file.startsWith(`${folder}/`),
    ))
    .sort();

  expect(outside.map(
    (file) => `${file} is outside the metro watchFolders; add its folder to soul-app/scripts/shared-source-folders.cjs`,
  )).toEqual([]);
});

test('all metro configs share the same source folder list', () => {
  const configs = [
    'soul-app/metro.config.js',
    'soul-app/scripts/review-metro-config.cjs',
    'soul-app/scripts/visual-check/attachment_preview/metro.config.js',
  ];
  const broken = configs.filter((config) => {
    const sourceText = fs.readFileSync(path.join(repoRoot, config), 'utf8');
    return !sourceText.includes('shared-source-folders.cjs') || sourceText.includes('packages/');
  });

  expect(broken.map(
    (config) => `${config} must require shared-source-folders.cjs and must not spell out packages/ folders`,
  )).toEqual([]);
});

test('shared package sources imported by soul-app only use packages the app declares', () => {
  const appManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'soul-app', 'package.json'), 'utf8'),
  );
  const undeclared = packageClosure(false).packageNameImports
    .filter(({ specifier }) => appManifest.dependencies?.[specifier] === undefined)
    .map(({ file, specifier }) => `${file} imports ${specifier}, but soul-app/package.json does not declare it`);

  expect(undeclared).toEqual([]);
});

test('the soul-app workflow runs for every shared package the app reaches, with or without types', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/soul-app.yml'), 'utf8');
  const packageDirectories = [...new Set(
    [...packageClosure(true).packageFiles]
      .filter((file) => file.startsWith('packages/'))
      .map((file) => file.split('/')[1]),
  )].sort();
  const uncovered = packageDirectories.filter((directory) => {
    const pattern = `packages/${directory}/**`;
    return workflow.split(pattern).length - 1 < 2;
  });

  expect(uncovered.map(
    (directory) => `packages/${directory}/** must appear in both push and pull_request paths of .github/workflows/soul-app.yml`,
  )).toEqual([]);
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

test('allows the shared persistent turn usage source for app imports', () => {
  const sharedSource = 'packages/soul-ui/src/lib/persistent-turn-usage.ts';
  const allowedLines = new Set(
    fs.readFileSync(path.join(repoRoot, '.easignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim()),
  );

  expect(() => assertPackageFilesAllowed(new Set([sharedSource]), allowedLines)).not.toThrow();
});

function sourceFilesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function moduleSpecifiers(
  filePath: string,
  sourceText = fs.readFileSync(filePath, 'utf8'),
  includeTypeOnly = false,
): string[] {
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
    if (ts.isImportDeclaration(node) && (includeTypeOnly || !isTypeOnlyImport(node))) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && (includeTypeOnly || !isTypeOnlyExport(node))) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && (includeTypeOnly || !node.isTypeOnly)
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

function resolvePackageNameImport(importer: string, specifier: string): { manifestPath: string; entryPath: string } | null {
  if (specifier !== '@soulstream/chat-ui' || !isWithin(appSourceRoot, importer)) return null;

  const appManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'soul-app/package.json'), 'utf8'));
  if (appManifest.dependencies?.[specifier] !== 'file:../packages/chat-ui') {
    throw new Error('soul-app must use the local @soulstream/chat-ui package.');
  }

  const manifestPath = path.join(chatUiRoot, 'package.json');
  const packageManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    packageManifest.name !== specifier
    || packageManifest.main !== 'src/index.ts'
    || packageManifest.types !== 'src/index.ts'
    || packageManifest.exports?.['.'] !== './src/index.ts'
  ) {
    throw new Error('@soulstream/chat-ui must expose its public src/index.ts entry.');
  }

  const entryPath = path.resolve(chatUiRoot, packageManifest.exports['.']);
  if (!isWithin(chatUiRoot, entryPath) || !fs.existsSync(entryPath)) {
    throw new Error('@soulstream/chat-ui public entry is missing from packages.');
  }
  return { manifestPath, entryPath };
}

function resolveRelativePackageImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const basePath = path.resolve(path.dirname(importer), specifier);
  if (!isWithin(packagesRoot, basePath)) return null;

  const jsRequest = basePath.endsWith('.js');
  const candidates = jsRequest
    ? [`${basePath.slice(0, -3)}.ts`, `${basePath.slice(0, -3)}.tsx`, basePath]
    : path.extname(basePath)
      ? [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, 'index.ts'),
        path.join(basePath, 'index.tsx'),
      ]
    : [
      `${basePath}.ts`,
      `${basePath}.tsx`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
    ];
  let importedFile = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!importedFile && fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    const packageManifestPath = path.join(basePath, 'package.json');
    if (fs.existsSync(packageManifestPath)) {
      const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, 'utf8'));
      const entry = packageManifest.types ?? packageManifest.main;
      if (typeof entry === 'string') {
        const entryPath = path.resolve(basePath, entry);
        if (fs.existsSync(entryPath) && fs.statSync(entryPath).isFile()) importedFile = entryPath;
      }
    }
  }
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
