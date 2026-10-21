import fs from 'node:fs';
import path from 'node:path';

test('새 세션·새 카드 공통 입력과 새 세션 sheet 제품 마운트를 전수 고정한다', () => {
  expect(findProductFilesContaining(/<GrowingMultilineInput\b/)).toEqual([
    'components/planner/CardCreateSheet.tsx',
    'components/planner/SessionSuccessionSheet.tsx',
  ]);

  expect(findProductFilesContaining(
    /<SessionSuccessionSheet\b/,
    new Set(['components/planner/SessionSuccessionSheet.tsx']),
  )).toEqual([
    // 검수 갤러리는 복제 없이 실제 sheet를 직접 마운트합니다.
    'component-review/ReviewDialogueSurface.tsx',
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

test('PAS 카드 시트와 검수 샘플은 iOS 키보드 회피와 원형 축소 버튼을 공유한다', () => {
  for (const path of ['screens/PersistentSessionScreen.tsx', 'component-review/ReviewPasCardExpand.tsx']) {
    const source = read(path);
    const scroll = source.match(/<ScrollView style=\{\{ flex: 1, minHeight: 0 \}\}[\s\S]*?<\/ScrollView>/)?.[0];
    expect(scroll).toBeDefined();
    expect(scroll).toContain('keyboardDismissMode="interactive"');
    expect(scroll).toContain("automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}");
    expect(source).toMatch(/<PersistentReportCardSheetHeader\b/);
  }
  const header = read('components/persistent/PersistentReportCardSheetHeader.tsx');
  expect(header).toMatch(/<GlassButton\s+testID="persistent-report-card-sheet-collapse"\s+iconOnly\s+size="compact"\s+borderRadius=\{t\.foundation\.radius\.round\}/);
  expect(header).toContain("name=\"contract-outline\"");
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
