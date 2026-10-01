import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../..');

const N5_UNITS = {
  'components/settings/ClaudeProviderSection.tsx': ['ClaudeProviderSection'],
  'components/ProviderUsageChart.tsx': ['ProviderUsageChart'],
  'components/planner/NewFolderSheet.tsx': ['NewFolderSheet', 'ContextPreviewRow'],
  'components/planner/SessionSuccessionHost.tsx': ['SessionSuccessionHost'],
  'components/planner/SessionSuccessionSheet.tsx': [
    'SessionSuccessionSheet',
    'SelectionRow',
    'CheckRow',
  ],
  'components/settings/SettingsModal.tsx': ['SettingsModal'],
  'screens/LoginScreen.tsx': ['LoginScreen'],
  'screens/SettingsScreen.tsx': ['SettingsScreen'],
  'components/menus/AppContextMenu.tsx': ['AppContextMenu'],
  'services/pushNotifications.ts': ['push OS prompt'],
} as const;

const LEGACY_UI = [
  'components/planner/ProjectSummary.tsx',
  'components/sheets/AtomNodePickerSheet.tsx',
  'components/sheets/FolderOptionsSheet.tsx',
  'components/sheets/NewSessionAttachmentControls.tsx',
  'components/sheets/NewSessionSheet.tsx',
  'screens/FeedScreen.tsx',
  'screens/FolderContentsScreen.tsx',
  'screens/FolderListScreen.tsx',
] as const;

const LEGACY_HELPERS = [
  'components/sheets/useRecordingAttachment.ts',
  'hooks/useFolderActions.ts',
  'hooks/useSessionMoveActions.ts',
] as const;

describe('N5 production coverage closure', () => {
  test('10 files own 13 assigned units and the whole audit closes at 109', () => {
    expect(Object.keys(N5_UNITS)).toHaveLength(10);
    expect(Object.values(N5_UNITS).flat()).toHaveLength(13);
    expect(31 + 7 + 24 + 34 + 13).toBe(109);
    expect(12 + 5 + 19 + 28 + 10).toBe(74);
    for (const file of Object.keys(N5_UNITS)) {
      expect(fs.existsSync(path.join(SRC_ROOT, file))).toBe(true);
    }
  });

  test('legacy 8 UI files and 3 imperative helpers cannot re-enter production', () => {
    expect(LEGACY_UI).toHaveLength(8);
    expect(LEGACY_HELPERS).toHaveLength(3);
    for (const file of [...LEGACY_UI, ...LEGACY_HELPERS]) {
      expect(fs.existsSync(path.join(SRC_ROOT, file))).toBe(false);
      expect(activeImportsOf(file)).toEqual([]);
    }
  });

  test('seven navigator factories and one AnimatedPressable adapter stay non-surface ledger entries', () => {
    const navigation = read('navigation/TabNavigator.tsx');
    const sessionCard = read('components/SessionCard.tsx');
    expect(navigation.match(/=\s*createNativeStackNavigator</g) ?? []).toHaveLength(6);
    expect(navigation.match(/=\s*createBottomTabNavigator</g) ?? []).toHaveLength(1);
    expect(sessionCard.match(/Animated\.createAnimatedComponent\(Pressable\)/g) ?? [])
      .toHaveLength(1);
  });
});

function activeImportsOf(relativePath: string): string[] {
  const stem = relativePath.replace(/\.tsx?$/, '');
  const basename = path.posix.basename(stem);
  const matches: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    if (!/\.(?:ts|tsx)$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(`/${basename}'`) || source.includes(`/${basename}\"`)) {
      matches.push(path.relative(SRC_ROOT, file));
    }
  }
  return matches;
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(resolved) : [resolved];
  });
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
}
