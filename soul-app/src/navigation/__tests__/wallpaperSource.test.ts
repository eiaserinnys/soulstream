jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('../TabNavigator', () => ({ TabNavigator: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../../screens/LoginScreen', () => ({ LoginScreen: () => null }));
jest.mock('../../components/split/SplitLayout', () => ({ SplitLayout: () => null }));
jest.mock('../navigationRef', () => ({
  navigationRef: { isReady: jest.fn(() => false), navigate: jest.fn() },
}));
jest.mock('../../services/pushNotifications', () => ({
  ensurePushRegistered: jest.fn(),
  deregisterFromServer: jest.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import { resolveBackgroundImageSource } from '../../lib/wallpaper-source';

describe('resolveBackgroundImageSource', () => {
  test('same-origin custom photo에는 JWT Bearer header를 붙인다', () => {
    expect(resolveBackgroundImageSource(
      'https://soul.example.com/',
      '/api/user/background',
      'jwt-token',
    )).toEqual({
      uri: 'https://soul.example.com/api/user/background',
      headers: { Authorization: 'Bearer jwt-token' },
    });
  });

  test('외부 URL과 로컬 파일에는 JWT를 노출하지 않는다', () => {
    expect(resolveBackgroundImageSource(
      'https://soul.example.com',
      'https://images.example.net/photo.jpg',
      'jwt-token',
    )).toEqual({ uri: 'https://images.example.net/photo.jpg' });
    expect(resolveBackgroundImageSource(
      'https://soul.example.com',
      'file:///tmp/photo.jpg',
      'jwt-token',
    )).toEqual({ uri: 'file:///tmp/photo.jpg' });
  });

  test('사진 경로가 없으면 source를 만들지 않는다', () => {
    expect(resolveBackgroundImageSource('https://soul.example.com', undefined, 'jwt-token'))
      .toBeNull();
    expect(resolveBackgroundImageSource('', '/api/user/background', 'jwt-token'))
      .toBeNull();
  });
});

test('루트 배경은 appearance와 wallpaper store를 직접 구독해 변경 즉시 다시 계산한다', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../RootNavigator.tsx'), 'utf8');
  const tokenSource = fs.readFileSync(path.resolve(__dirname, '../../theme/tokens.ts'), 'utf8');

  expect(source).toContain('const wallpaper = useSettingsStore((s) => s.wallpaper);');
  expect(source).toContain('const tokens = useTokens();');
  expect(source).toContain('resolveWallpaperColor(wallpaper.mode, tokens)');
  expect(tokenSource).toContain('const appearance = useSettingsStore((s) => s.appearance);');
});

test('루트와 설정 preview는 같은 wallpaper source 정본을 사용한다', () => {
  const rootSource = fs.readFileSync(path.resolve(__dirname, '../RootNavigator.tsx'), 'utf8');
  const settingsSource = fs.readFileSync(path.resolve(__dirname, '../../screens/SettingsContent.tsx'), 'utf8');

  expect(rootSource).toContain("from '../lib/wallpaper-source'");
  expect(settingsSource).toContain("from '../lib/wallpaper-source'");
  expect(settingsSource).not.toContain('function resolvePreviewSource(');
  expect(settingsSource).not.toContain('function sameOrigin(');
});
