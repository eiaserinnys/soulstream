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
    'component-review/ReviewIphoneDuo.tsx',
    'components/planner/FolderWorkspaceReadOverlay.tsx',
    'components/split/MainListPane.tsx',
    'navigation/TabNavigator.tsx',
  ]);
});

test('SessionSuccessionSheet는 iOS 키보드 회피와 ScrollView 입력 동작을 함께 사용한다', () => {
  const source = read('components/planner/SessionSuccessionSheet.tsx');

  expect(source).toMatch(
    /<ScrollView[\s\S]*automaticallyAdjustKeyboardInsets=\{Platform\.OS === 'ios'\}/,
  );
  expect(source).toMatch(/<AppKeyboardAvoidingView[^>]*behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
  expect(source).not.toContain('useFocusedViewportEndFollow');
});

test('모바일 PAS 보고는 카드를 직행으로 열고 검수 창에도 구버전 시트가 없다', () => {
  expect(read('screens/PersistentSessionScreen.tsx')).not.toMatch(/<PersistentReportCardSheetHeader\b/);

  const reviewExpand = read('component-review/ReviewPasCardExpand.tsx');
  expect(reviewExpand).not.toMatch(/<PersistentReportCardSheetHeader\b/);
  expect(reviewExpand).not.toMatch(/<PersistentReportCardSheetComplete\b/);
  expect(reviewExpand).not.toMatch(/<AppModalSurface\b/);
  expect(reviewExpand).toMatch(/<CardDetailContent\b/);
  expect(fs.existsSync(path.resolve(__dirname, '../../../components/persistent/PersistentReportCardSheetHeader.tsx'))).toBe(false);
  expect(fs.existsSync(path.resolve(__dirname, '../../../components/persistent/PersistentReportCardSheetComplete.tsx'))).toBe(false);

  const duoReview = read('component-review/ReviewIphoneDuo.tsx');
  expect(duoReview).toMatch(/onOpenPhoneCard=\{frame\.rail \? setOpenedCardId : undefined\}/);
  expect(duoReview).toMatch(/<CardDetailContent visible api=\{reviewCardApi\} cardId=\{openedCardId\}/);
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
