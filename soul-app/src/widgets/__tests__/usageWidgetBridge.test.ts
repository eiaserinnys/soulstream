import React from 'react';
import { act, render } from '@testing-library/react-native';

// 공개 조회 함수 하나만 가로챈다. expo-modules-core를 jest.mock으로 통째 교체하면
// jest-expo가 준비한 네이티브 모듈 mock까지 실제 구현으로 돌아가, 같은 모듈 그래프의
// expo-file-system(settingsStore → preferencesEndpoints 경유) import가 깨진다.
const mockRequireOptionalNativeModule = jest.fn();
const ExpoModulesCore = require('expo-modules-core');

import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  USAGE_WIDGET_AUTH_TOKEN_KEY,
  USAGE_WIDGET_KIND,
  USAGE_WIDGET_LAST_SYNC_AT_KEY,
  USAGE_WIDGET_SERVER_URL_KEY,
  UsageWidgetCredentialSync,
  syncUsageWidgetCredentials,
  useUsageWidgetBridgeDiagnostics,
} from '../usageWidgetBridge';

const values = new Map<string, string>();
const nativeModule = {
  setString: jest.fn((key: string, value: string) => {
    values.set(key, value);
  }),
  remove: jest.fn((key: string) => {
    values.delete(key);
  }),
  get: jest.fn((key: string) => values.get(key)),
  reloadWidget: jest.fn(),
};

beforeEach(() => {
  values.clear();
  Object.values(nativeModule).forEach((fn) => fn.mockClear());
  mockRequireOptionalNativeModule.mockReset().mockReturnValue(nativeModule);
  jest
    .spyOn(ExpoModulesCore, 'requireOptionalNativeModule')
    .mockImplementation(mockRequireOptionalNativeModule);
  useAuthStore.setState({ jwt: 'secret-token' });
  useSettingsStore.setState({ serverUrl: 'https://soul.example///' });
  useUsageWidgetBridgeDiagnostics.getState().reset();
  jest.spyOn(useAuthStore.persist, 'hasHydrated').mockReturnValue(true);
  jest.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('공개 Expo API로 네이티브 모듈을 확인하고 자격증명·동기화 시각을 기록한다', () => {
  const result = syncUsageWidgetCredentials({
    serverUrl: 'https://soul.example///',
    jwt: 'secret-token',
    now: new Date('2026-07-21T04:00:00.000Z'),
  });

  expect(mockRequireOptionalNativeModule).toHaveBeenCalledWith('ExtensionStorage');
  expect(nativeModule.setString.mock.calls).toEqual([
    [USAGE_WIDGET_SERVER_URL_KEY, 'https://soul.example', 'group.me.eiaserinnys.soulstream'],
    [USAGE_WIDGET_AUTH_TOKEN_KEY, 'secret-token', 'group.me.eiaserinnys.soulstream'],
    [USAGE_WIDGET_LAST_SYNC_AT_KEY, '2026-07-21T04:00:00.000Z', 'group.me.eiaserinnys.soulstream'],
  ]);
  expect(nativeModule.reloadWidget).toHaveBeenCalledWith(USAGE_WIDGET_KIND);
  expect(result).toEqual(expect.objectContaining({
    nativeModuleAvailable: true,
    serverURLRecorded: true,
    authTokenRecorded: true,
    lastSyncAt: '2026-07-21T04:00:00.000Z',
    error: null,
  }));
});

test('네이티브 모듈 부재를 조용히 삼키지 않고 진단 상태로 반환한다', () => {
  mockRequireOptionalNativeModule.mockReturnValue(null);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const result = syncUsageWidgetCredentials({
    serverUrl: 'https://soul.example',
    jwt: 'secret-token',
  });

  expect(result).toEqual(expect.objectContaining({
    nativeModuleAvailable: false,
    serverURLRecorded: false,
    authTokenRecorded: false,
    lastSyncAt: null,
  }));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ExtensionStorage'));
});

test('모듈 객체가 있어도 App Group write가 남지 않으면 검증 실패를 노출한다', () => {
  nativeModule.setString.mockImplementationOnce(() => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const result = syncUsageWidgetCredentials({
    serverUrl: 'https://soul.example',
    jwt: 'secret-token',
    now: new Date('2026-07-21T04:00:30.000Z'),
  });

  expect(result).toEqual(expect.objectContaining({
    nativeModuleAvailable: true,
    serverURLRecorded: false,
    authTokenRecorded: true,
    lastSyncAt: '2026-07-21T04:00:30.000Z',
    error: expect.stringContaining('다시 읽어 확인하지 못했습니다'),
  }));
  expect(warn).toHaveBeenCalled();
});

test('로그아웃·설정 해제는 공유 값을 제거하고 결측 상태를 기록한다', () => {
  values.set(USAGE_WIDGET_SERVER_URL_KEY, 'old');
  values.set(USAGE_WIDGET_AUTH_TOKEN_KEY, 'old');

  const result = syncUsageWidgetCredentials({
    serverUrl: '  ',
    jwt: null,
    now: new Date('2026-07-21T04:01:00.000Z'),
  });

  expect(nativeModule.remove.mock.calls).toEqual([
    [USAGE_WIDGET_SERVER_URL_KEY, 'group.me.eiaserinnys.soulstream'],
    [USAGE_WIDGET_AUTH_TOKEN_KEY, 'group.me.eiaserinnys.soulstream'],
  ]);
  expect(result.serverURLRecorded).toBe(false);
  expect(result.authTokenRecorded).toBe(false);
});

test('두 저장소 hydration 전에는 기록하지 않고 완료 직후 한 번 동기화한다', () => {
  let authHydrated = false;
  let settingsHydrated = false;
  let finishAuth: (() => void) | undefined;
  let finishSettings: (() => void) | undefined;
  jest.spyOn(useAuthStore.persist, 'hasHydrated').mockImplementation(() => authHydrated);
  jest.spyOn(useSettingsStore.persist, 'hasHydrated').mockImplementation(() => settingsHydrated);
  jest.spyOn(useAuthStore.persist, 'onFinishHydration').mockImplementation((listener) => {
    finishAuth = listener as () => void;
    return jest.fn();
  });
  jest.spyOn(useSettingsStore.persist, 'onFinishHydration').mockImplementation((listener) => {
    finishSettings = listener as () => void;
    return jest.fn();
  });

  render(React.createElement(UsageWidgetCredentialSync));
  expect(nativeModule.setString).not.toHaveBeenCalled();

  authHydrated = true;
  settingsHydrated = true;
  act(() => {
    finishAuth?.();
    finishSettings?.();
  });

  expect(nativeModule.setString).toHaveBeenCalledWith(
    USAGE_WIDGET_SERVER_URL_KEY,
    'https://soul.example',
    'group.me.eiaserinnys.soulstream',
  );
});

test('백그라운드를 거쳐 active로 돌아오면 현재 자격증명을 다시 동기화한다', () => {
  render(React.createElement(UsageWidgetCredentialSync));
  nativeModule.setString.mockClear();

  act(() => {
    const listeners = (globalThis as any).__appStateListeners as Array<(state: string) => void>;
    listeners.forEach((listener) => listener('background'));
    listeners.forEach((listener) => listener('active'));
  });

  expect(nativeModule.setString).toHaveBeenCalledWith(
    USAGE_WIDGET_SERVER_URL_KEY,
    'https://soul.example',
    'group.me.eiaserinnys.soulstream',
  );
});
