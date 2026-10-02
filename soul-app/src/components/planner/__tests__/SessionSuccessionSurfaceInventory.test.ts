import fs from 'node:fs';
import path from 'node:path';

test('새 세션 초기 지시 입력과 sheet 제품 마운트를 전수 고정한다', () => {
  expect(findProductFilesContaining(/<GrowingMultilineInput\b/)).toEqual([
    'components/planner/SessionSuccessionSheet.tsx',
  ]);

  expect(findProductFilesContaining(
    /<SessionSuccessionSheet\b/,
    new Set(['components/planner/SessionSuccessionSheet.tsx']),
  )).toEqual([
    'components/planner/SessionSuccessionHost.tsx',
  ]);

  expect(findProductFilesContaining(/<SessionSuccessionHost\b/)).toEqual([
    'components/planner/FolderWorkspace.tsx',
    'screens/ChatScreen.tsx',
    'screens/SessionFeedScreen.tsx',
  ]);
});

test('FolderWorkspace 새 세션 표면은 phone과 tablet 경로를 모두 지난다', () => {
  expect(findProductFilesContaining(/<FolderWorkspace\b/)).toEqual([
    'component-review/ReviewFolderWorkspace.tsx',
    'components/planner/FolderWorkspaceReadOverlay.tsx',
    'components/split/MainListPane.tsx',
    'navigation/TabNavigator.tsx',
  ]);
});

test('SessionSuccessionSheet는 iOS 키보드 조정을 바깥 native ScrollView에 맡긴다', () => {
  const source = read('components/planner/SessionSuccessionSheet.tsx');

  expect(source).toMatch(
    /<ScrollView[\s\S]*automaticallyAdjustKeyboardInsets=\{Platform\.OS === 'ios'\}/,
  );
  expect(source).not.toContain('AppKeyboardAvoidingView');
  expect(source).not.toContain('useFocusedViewportEndFollow');
});

function read(relativePath: string): string {
  const sourceRoot = path.resolve(__dirname, '../../..');
  return fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
}

function findProductFilesContaining(
  pattern: RegExp,
  excludedFiles: ReadonlySet<string> = new Set(),
): string[] {
  const sourceRoot = path.resolve(__dirname, '../../..');
  const matches: string[] = [];

  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(absolute);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      const relative = path.relative(sourceRoot, absolute).replaceAll(path.sep, '/');
      if (excludedFiles.has(relative)) continue;
      if (pattern.test(fs.readFileSync(absolute, 'utf8'))) matches.push(relative);
    }
  }

  visit(sourceRoot);
  return matches.sort();
}
