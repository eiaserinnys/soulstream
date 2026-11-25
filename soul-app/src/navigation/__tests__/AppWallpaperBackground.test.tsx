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

import { StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { AppWallpaperBackground } from '../RootNavigator';
import { resolveBackgroundImageSource } from '../../lib/wallpaper-source';

const SERVER = 'https://soul.test';

test('사진 배경은 바닥 그림(cover, 절대 배치로 채움) 뒤에 자식을 두고 서버 v 주소를 memory-disk로 그린다', () => {
  const screen = render(<AppWallpaperBackground serverUrl={SERVER} jwt="tok"
    wallpaper={{ mode: 'photo', customImage: '/api/user/background?v=1700000000' }}>
    <Text testID="child">자식</Text>
  </AppWallpaperBackground>);
  const image = screen.getByTestId('app-wallpaper-image');
  expect(image.props.source).toEqual({ uri: `${SERVER}/api/user/background?v=1700000000`, headers: { Authorization: 'Bearer tok' } });
  expect(image.props.contentFit).toBe('cover');
  expect(image.props.accessibilityIgnoresInvertColors).toBe(true);
  expect(image.props.cachePolicy).toBe('memory-disk');
  expect(StyleSheet.flatten(image.props.style)).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.42 });

  const root = screen.toJSON() as unknown as { type: string; props: { style: unknown }; children: Array<{ props: { testID?: string } }> };
  expect(root.type).toBe('View');
  expect(StyleSheet.flatten(root.props.style as never)).toMatchObject({ flex: 1 });
  expect(root.children.map((child) => child.props.testID)).toEqual(['app-wallpaper-image', 'child']);
  expect(screen.UNSAFE_getAllByType(Image)).toHaveLength(1);
});

test('v 없는 배경 주소는 디스크에 남기지 않는다', () => {
  const screen = render(<AppWallpaperBackground serverUrl={SERVER} jwt="tok"
    wallpaper={{ mode: 'photo', customImage: '/api/user/background' }}>
    <Text>자식</Text>
  </AppWallpaperBackground>);
  expect(screen.getByTestId('app-wallpaper-image').props.cachePolicy).toBe('memory');
});

test('사진 모드가 아니면 그림 없이 자식만 그린다', () => {
  const screen = render(<AppWallpaperBackground serverUrl={SERVER} jwt="tok" wallpaper={{ mode: 'bokeh' }}>
    <Text testID="child">자식</Text>
  </AppWallpaperBackground>);
  expect(screen.queryByTestId('app-wallpaper-image')).toBeNull();
  expect(screen.getByTestId('child')).toBeTruthy();
});

test('서버가 준 배경 주소의 v를 그대로 지킨다', () => {
  expect(resolveBackgroundImageSource(SERVER, '/api/user/background?v=1700000000', 'tok')).toEqual({
    uri: `${SERVER}/api/user/background?v=1700000000`,
    headers: { Authorization: 'Bearer tok' },
  });
});
