import {
  isUsageWidgetDeepLink,
  routeUsageWidgetDeepLink,
} from '../usageWidgetDeepLink';

test.each([
  'soulstream://usage',
  'soulstream://usage/',
  'soulstream:///usage',
])('%s를 사용량 위젯 딥링크로 인식한다', (url) => {
  expect(isUsageWidgetDeepLink(url)).toBe(true);
});

test.each([
  'soulstream://settings',
  'https://example.test/usage',
  'not a url',
  null,
])('%s는 사용량 위젯 딥링크가 아니다', (url) => {
  expect(isUsageWidgetDeepLink(url)).toBe(false);
});

test('phone은 기존 SettingsTab으로 이동한다', () => {
  const navigateSettings = jest.fn();
  const openTabletSettings = jest.fn();

  expect(routeUsageWidgetDeepLink('phone', navigateSettings, openTabletSettings)).toBe(true);
  expect(navigateSettings).toHaveBeenCalledTimes(1);
  expect(openTabletSettings).not.toHaveBeenCalled();
});

test.each(['tabletPortrait', 'tabletLandscape'] as const)(
  '%s는 기존 iPad SettingsModal을 연다',
  (device) => {
    const navigateSettings = jest.fn();
    const openTabletSettings = jest.fn();

    expect(routeUsageWidgetDeepLink(device, navigateSettings, openTabletSettings)).toBe(true);
    expect(openTabletSettings).toHaveBeenCalledTimes(1);
    expect(navigateSettings).not.toHaveBeenCalled();
  },
);
