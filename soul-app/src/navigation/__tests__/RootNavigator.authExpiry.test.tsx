import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('../AuthenticatedAppSubtree', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    AuthenticatedAppSubtree: () => ReactModule.createElement(
      Text,
      { testID: 'authenticated-app' },
      'Authenticated app',
    ),
  };
});
jest.mock('../../screens/LoginScreen', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    LoginScreen: () => ReactModule.createElement(Text, { testID: 'login-screen' }, 'Login'),
  };
});
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null, FirstConnectionSettingsScreen: () => null }));
jest.mock('../../services/pushNotifications', () => ({
  ensurePushRegistered: jest.fn(async () => undefined),
  deregisterFromServer: jest.fn(async () => undefined),
}));
jest.mock('../../theme', () => ({
  useTokens: () => ({ mode: 'dark', colors: { background: '#000', accent: '#fff' } }),
}));
jest.mock('../../theme/useDeviceType', () => ({
  useDeviceType: jest.fn(() => 'phone'),
}));
jest.mock('../../widgets/usageWidgetDeepLink', () => ({ useUsageWidgetDeepLink: jest.fn() }));
jest.mock('../../lib/wallpaper-source', () => ({ resolveBackgroundImageSource: () => null }));
jest.mock('../../lib/ui-usage-events', () => ({ recordUiUsageEvent: jest.fn() }));
jest.mock('../navigationRef', () => ({
  navigationRef: { isReady: jest.fn(() => false), navigate: jest.fn() },
}));
jest.mock('../notificationSessionRoute', () => ({ openNotificationSession: jest.fn() }));
jest.mock('../phoneSessionNavigation', () => ({
  openPhoneSearchSessionFromRoot: jest.fn(),
  cancelPhoneSearchSessionOpen: jest.fn(),
}));
jest.mock('../../lib/planner-folder-workspace', () => ({
  openPlannerSessionWorkspace: jest.fn(),
  cancelPlannerSessionWorkspaceOpen: jest.fn(),
}));

import { RootNavigator } from '../RootNavigator';
import { navigationRef } from '../navigationRef';
import { useDeviceType } from '../../theme/useDeviceType';
import {
  cancelPhoneSearchSessionOpen,
  openPhoneSearchSessionFromRoot,
} from '../phoneSessionNavigation';
import {
  cancelPlannerSessionWorkspaceOpen,
  openPlannerSessionWorkspace,
} from '../../lib/planner-folder-workspace';
import { createApiClient } from '../../api/client';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';

const BASE = 'https://soul.test';
const isFolderRequest = (input: RequestInfo | URL) =>
  new URL(String(input), BASE).pathname === '/api/folders';
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

let fetchMock: jest.Mock;
let configRequest: () => Promise<Response>;

beforeEach(() => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  jest.spyOn(Linking, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);
  (navigationRef.isReady as jest.Mock).mockReset().mockReturnValue(false);
  (useDeviceType as jest.Mock).mockReset().mockReturnValue('phone');
  (openPhoneSearchSessionFromRoot as jest.Mock).mockReset().mockResolvedValue(false);
  (cancelPhoneSearchSessionOpen as jest.Mock).mockReset();
  (openPlannerSessionWorkspace as jest.Mock).mockReset().mockResolvedValue(false);
  (cancelPlannerSessionWorkspaceOpen as jest.Mock).mockReset();
  configRequest = async () => jsonResponse({ authEnabled: true });
  fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/auth/config')) return configRequest();
    if (url.endsWith('/api/user/preferences')) {
      return Promise.resolve(jsonResponse({
        preferences: { appearance: 'system', wallpaper: { mode: 'bokeh' } },
      }));
    }
    if (
      url.includes('/api/planner/today')
      || isFolderRequest(input)
      || url.includes('/api/sessions')
    ) {
      return Promise.resolve(jsonResponse({ detail: 'unauthorized' }, 401));
    }
    return Promise.resolve(jsonResponse({}));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  useSettingsStore.setState({ serverUrl: BASE, wallpaper: { mode: 'bokeh' } });
  useUIStore.setState({
    sessionSearchIntentId: null,
    completedSessionSearchIntentId: null,
    activeSessionId: null,
    selectedFolderPageId: null,
    sessionFolderResolution: null,
  });
  useAuthStore.setState({ jwt: 'expired-jwt', authRejected: false });
  resetAuthScopeForTest();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('session deep link waits for auth readiness and then opens the exact session event', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  const initialUrl = 'soulstream:///?session=session-a&event=42';
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(initialUrl);
  jest.spyOn(Linking, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);
  (navigationRef.isReady as jest.Mock).mockReturnValue(true);
  (openPhoneSearchSessionFromRoot as jest.Mock)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  expect(openPhoneSearchSessionFromRoot).not.toHaveBeenCalled();

  await act(async () => {
    useAuthStore.getState().setJwt('new-jwt');
  });

  await waitFor(() => expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.resolve();
    useAuthStore.getState().setJwt('renewed-jwt');
  });
  await waitFor(() => expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledTimes(2));
  expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledWith(
    navigationRef,
    'session-a',
    42,
    expect.any(Function),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
});

test('phone session intent can retry after linked-task resolution fails', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(
    'soulstream:///?session=retry-session&event=51',
  );
  (navigationRef.isReady as jest.Mock).mockReturnValue(true);
  (openPhoneSearchSessionFromRoot as jest.Mock)
    .mockImplementationOnce((_navigation, _sessionId, _eventId, onResolutionFailure) => {
      onResolutionFailure?.();
      return Promise.resolve(false);
    })
    .mockResolvedValueOnce(true);
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  await act(async () => {
    useAuthStore.getState().setJwt('new-jwt');
  });
  await waitFor(() => expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));

  const retryButton = alertSpy.mock.calls[0][2]?.find((button) => button.text === '다시 시도');
  expect(retryButton?.onPress).toBeDefined();
  await act(async () => {
    retryButton?.onPress?.();
    await Promise.resolve();
  });

  await waitFor(() => expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledTimes(2));
  expect(openPhoneSearchSessionFromRoot).toHaveBeenLastCalledWith(
    navigationRef,
    'retry-session',
    51,
    expect.any(Function),
  );
});

test('tablet session deep link opens the exact session event after auth readiness', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  (useDeviceType as jest.Mock).mockReturnValue('tabletPortrait');
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(
    'soulstream:///?session=tablet-session&event=73',
  );
  (navigationRef.isReady as jest.Mock).mockReturnValue(true);
  (openPlannerSessionWorkspace as jest.Mock).mockResolvedValue(true);
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  expect(openPlannerSessionWorkspace).not.toHaveBeenCalled();

  await act(async () => {
    useAuthStore.getState().setJwt('new-jwt');
  });

  await waitFor(() => expect(openPlannerSessionWorkspace).toHaveBeenCalledTimes(1));
  expect(openPlannerSessionWorkspace).toHaveBeenCalledWith(
    'tablet-session',
    73,
    undefined,
    'search',
    1,
  );
});

test('a late initial URL does not replace a newer session-link event', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  (navigationRef.isReady as jest.Mock).mockReturnValue(true);
  (openPhoneSearchSessionFromRoot as jest.Mock).mockResolvedValue(true);
  let resolveInitial!: (url: string | null) => void;
  jest.spyOn(Linking, 'getInitialURL').mockReturnValue(new Promise((resolve) => {
    resolveInitial = resolve;
  }));
  let receiveUrl: ((event: { url: string }) => void) | null = null;
  jest.spyOn(Linking, 'addEventListener').mockImplementation((
    ((event: string, listener: (payload: { url: string }) => void) => {
      if (event === 'url') receiveUrl = listener;
      return { remove: jest.fn() } as never;
    }) as typeof Linking.addEventListener
  ));
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  expect(receiveUrl).not.toBeNull();
  act(() => receiveUrl?.({ url: 'soulstream:///?session=latest-session' }));
  await act(async () => {
    resolveInitial('soulstream:///?session=older-session');
    await Promise.resolve();
    useAuthStore.getState().setJwt('new-jwt');
  });

  await waitFor(() => expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledTimes(1));
  expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledWith(
    navigationRef,
    'latest-session',
    undefined,
    expect.any(Function),
  );
});

test('an OAuth callback does not suppress a late initial session intent', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  (navigationRef.isReady as jest.Mock).mockReturnValue(true);
  (openPhoneSearchSessionFromRoot as jest.Mock).mockResolvedValue(true);
  let resolveInitial!: (url: string | null) => void;
  jest.spyOn(Linking, 'getInitialURL').mockReturnValue(new Promise((resolve) => {
    resolveInitial = resolve;
  }));
  let receiveUrl: ((event: { url: string }) => void) | null = null;
  jest.spyOn(Linking, 'addEventListener').mockImplementation((
    ((event: string, listener: (payload: { url: string }) => void) => {
      if (event === 'url') receiveUrl = listener;
      return { remove: jest.fn() } as never;
    }) as typeof Linking.addEventListener
  ));
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  act(() => receiveUrl?.({ url: 'soulstream://oauth?code=oauth-code' }));
  await act(async () => {
    resolveInitial('soulstream:///?session=initial-session&event=19');
    await Promise.resolve();
    useAuthStore.getState().setJwt('new-jwt');
  });

  await waitFor(() => expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledTimes(1));
  expect(openPhoneSearchSessionFromRoot).toHaveBeenCalledWith(
    navigationRef,
    'initial-session',
    19,
    expect.any(Function),
  );
});

test('a newer invalid session intent clears a valid intent waiting for authentication', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(
    'soulstream:///?session=session-a&event=42',
  );
  let receiveUrl: ((event: { url: string }) => void) | null = null;
  jest.spyOn(Linking, 'addEventListener').mockImplementation((
    ((event: string, listener: (payload: { url: string }) => void) => {
      if (event === 'url') receiveUrl = listener;
      return { remove: jest.fn() } as never;
    }) as typeof Linking.addEventListener
  ));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  await waitFor(() => expect(receiveUrl).not.toBeNull());
  act(() => receiveUrl?.({ url: 'soulstream:///?session=session-b&event=bad' }));

  expect(alert).toHaveBeenCalledWith(
    '세션 링크를 열 수 없습니다',
    '이벤트 번호가 잘못되었습니다.',
  );
  expect(cancelPhoneSearchSessionOpen).toHaveBeenCalledTimes(2);
  expect(cancelPlannerSessionWorkspaceOpen).toHaveBeenCalledTimes(2);

  await act(async () => {
    useAuthStore.getState().setJwt('new-jwt');
  });
  await Promise.resolve();

  expect(openPhoneSearchSessionFromRoot).not.toHaveBeenCalled();
  expect(openPlannerSessionWorkspace).not.toHaveBeenCalled();
});

test('tablet retry success consumes its original search intent before auth scope changes', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  (useDeviceType as jest.Mock).mockReturnValue('tabletPortrait');
  (navigationRef.isReady as jest.Mock).mockReturnValue(true);
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(
    'soulstream:///?session=tablet-retry&event=42',
  );
  (openPlannerSessionWorkspace as jest.Mock).mockResolvedValue(false);
  const screen = render(<RootNavigator />);

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  await act(async () => {
    useAuthStore.getState().setJwt('new-jwt');
  });
  await waitFor(() => expect(openPlannerSessionWorkspace).toHaveBeenCalledWith(
    'tablet-retry',
    42,
    undefined,
    'search',
    1,
  ));

  await act(async () => {
    useUIStore.setState({
      activeSessionId: 'tablet-retry',
      focusEventId: 42,
      selectedFolderPageId: null,
      folderOverlayVisible: true,
      sessionFolderResolution: {
        sessionId: 'tablet-retry',
        status: 'error',
        message: 'temporary failure',
        retryable: true,
      },
      sessionSearchIntentId: 1,
    });
  });
  await act(async () => {
    useUIStore.setState({
      activeSessionId: 'tablet-retry',
      focusEventId: 42,
      selectedFolderPageId: 'task-page',
      folderOverlayVisible: true,
      sessionFolderResolution: { sessionId: 'tablet-retry', status: 'unlinked' },
      sessionSearchIntentId: 1,
      completedSessionSearchIntentId: null,
    });
  });
  await act(async () => {
    useUIStore.getState().completeSessionSearchIntent(1);
  });
  await waitFor(() => expect(useUIStore.getState().sessionSearchIntentId).toBeNull());
  await act(async () => {
    useAuthStore.getState().setJwt('renewed-jwt');
  });

  expect(openPlannerSessionWorkspace).toHaveBeenCalledTimes(1);
});

test('auth 설정 성공 뒤 세션 조회 401은 로그인 화면으로 복귀한다', async () => {
  const screen = render(<RootNavigator />);
  await waitFor(() => expect(screen.getByTestId('authenticated-app')).toBeTruthy());

  await act(async () => {
    await expect(createApiClient(BASE).getCatalog({ feed_only: true }))
      .rejects.toMatchObject({ status: 401 });
  });

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  expect(useAuthStore.getState()).toMatchObject({ jwt: null, authRejected: true });
  expect(fetchMock.mock.calls.some(([input]) => isFolderRequest(input))).toBe(true);
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/sessions'))).toBe(true);
});

test('auth 설정 조회 실패 뒤 데일리 조회 401도 로그인 화면으로 복귀한다', async () => {
  configRequest = async () => { throw new Error('offline'); };
  const screen = render(<RootNavigator />);
  await waitFor(() => expect(screen.getByTestId('authenticated-app')).toBeTruthy());

  await act(async () => {
    await expect(createApiClient(BASE).getPlannerToday('2026-09-23'))
      .rejects.toMatchObject({ status: 401 });
  });

  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());
  expect(useAuthStore.getState()).toMatchObject({ jwt: null, authRejected: true });
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/planner/today'))).toBe(true);

  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (isFolderRequest(input)) return Promise.resolve(jsonResponse({ folders: [] }));
    if (url.includes('/api/sessions')) return Promise.resolve(jsonResponse({ sessions: [], total: 0 }));
    if (url.endsWith('/api/user/preferences')) {
      return Promise.resolve(jsonResponse({
        preferences: { appearance: 'system', wallpaper: { mode: 'bokeh' } },
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  await act(async () => {
    useAuthStore.getState().setJwt('new-jwt');
  });

  await waitFor(() => expect(screen.getByTestId('authenticated-app')).toBeTruthy());
  await expect(createApiClient(BASE).getCatalog({ feed_only: true })).resolves.toMatchObject({
    folders: [],
  });
  const catalogCalls = fetchMock.mock.calls.filter(([input]) =>
    isFolderRequest(input));
  const catalogRequest = catalogCalls[catalogCalls.length - 1];
  expect(new Headers(catalogRequest?.[1]?.headers).get('Authorization')).toBe('Bearer new-jwt');
  expect(useAuthStore.getState()).toMatchObject({ jwt: 'new-jwt', authRejected: false });
});

test('401 이후 늦게 끝난 설정 조회 실패가 로그인 거부 신호를 덮지 않는다', async () => {
  let rejectConfig!: (error: Error) => void;
  configRequest = () => new Promise<Response>((_resolve, reject) => { rejectConfig = reject; });
  const screen = render(<RootNavigator />);

  await act(async () => {
    await expect(createApiClient(BASE).getPlannerToday('2026-09-23'))
      .rejects.toMatchObject({ status: 401 });
  });
  await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy());

  await act(async () => {
    rejectConfig(new Error('late offline'));
    await Promise.resolve();
  });

  expect(screen.getByTestId('login-screen')).toBeTruthy();
  expect(useAuthStore.getState()).toMatchObject({ jwt: null, authRejected: true });
});
