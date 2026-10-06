import { INITIAL_ROOT_TAB, ROOT_TAB_ORDER } from '../tabContract';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_SECTION_CONFIG } from '../rootSectionConfig';

test('v3 탭 순서와 초기 탭은 Daily·Folder·Persistent·Feed·Settings 계약을 따른다', () => {
  expect(ROOT_TAB_ORDER).toEqual([
    'DailyTab',
    'FolderTab',
    'PersistentTab',
    'FeedTab',
    'SettingsTab',
  ]);
  expect(INITIAL_ROOT_TAB).toBe('DailyTab');
});

test('phone와 tablet root title과 tab/header icon key는 emoji 없는 한 정본이다', () => {
  expect(ROOT_SECTION_CONFIG).toEqual({
    FolderTab: { title: '폴더', icon: 'folder-outline' },
    DailyTab: { title: '카드', icon: 'grid-outline' },
    StarredTab: { title: '중요 작업', icon: 'star-outline' },
    ProjectTab: { title: '프로젝트', icon: 'folder-outline' },
    PersistentTab: { title: '영구 세션', icon: 'list-outline' },
    FeedTab: { title: '피드', icon: 'reader-outline' },
    ChatTab: { title: '챗', icon: 'chatbubble-ellipses-outline' },
    SettingsTab: { title: '설정', icon: 'settings-outline' },
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../TabNavigator.tsx'), 'utf8');
  expect(source).toContain('const config = ROOT_SECTION_CONFIG[name]');
  expect(source).not.toMatch(/[📅⭐📁📰💬⚙️]/u);
});
