import React from 'react';
import {
  render,
  waitFor,
  act,
  fireEvent,
  within,
} from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('../../components/AppGlassCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    AppGlassCard: ({ children, ...props }: any) => React.createElement(
      View,
      { ...props, accessibilityLabel: 'app-glass-card' },
      children,
    ),
  };
});

import { createApiClient } from '../../api/client';
import { SettingsScreen } from '../SettingsScreen';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUsageWidgetBridgeDiagnostics } from '../../widgets/usageWidgetBridge';

const realCreateApiClient = jest.requireActual('../../api/client').createApiClient as typeof createApiClient;
const CURRENT_SERVER_URL = 'https://current.test';
const OTHER_SERVER_URL = 'https://other.test';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const mockApi = {
  getConfig: jest.fn(),
  listNodes: jest.fn(),
  getClaudeAuthStatus: jest.fn(),
  getClaudeProfile: jest.fn(),
  getClaudeUsage: jest.fn(),
  startClaudeAuth: jest.fn(),
  submitClaudeCode: jest.fn(),
  deleteClaudeToken: jest.fn(),
  getProviderUsage: jest.fn(),
  getAuthStatus: jest.fn(),
};

beforeEach(() => {
  (createApiClient as jest.Mock).mockReturnValue(mockApi);
  Object.values(mockApi).forEach((fn) => (fn as jest.Mock).mockReset());
  // 기본값 — 노드 카드의 자동 fetch가 unhandled rejection을 내지 않도록 안전한 응답으로 초기화.
  mockApi.getClaudeAuthStatus.mockResolvedValue({ has_token: false });
  mockApi.getClaudeProfile.mockResolvedValue(null);
  mockApi.getAuthStatus.mockResolvedValue({
    authenticated: true,
    user: {
      email: 'user@example.com',
      name: 'User',
      picture: '',
      isAdmin: false,
    },
  });

  // settingsStore 초기화 — persist된 이전 테스트 상태가 누수되지 않도록 매번 명시.
  useSettingsStore.setState({
    serverUrl: 'http://test.example',
    serverType: 'orchestrator',
    nodeId: '',
    appearance: 'system',
  });
  useUsageWidgetBridgeDiagnostics.setState({
    hydrated: true,
    nativeModuleAvailable: true,
    serverURLRecorded: true,
    authTokenRecorded: true,
    lastSyncAt: '2026-07-21T04:00:00.000Z',
    error: null,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('non-flattened settings reserves the top safe area with the existing edges', async () => {
  mockApi.getConfig.mockResolvedValue({ mode: 'single', nodeId: 'me' });
  const screen = render(<SettingsScreen showAdmin={false} />);

  await waitFor(() => {
    expect(screen.getByTestId('settings-safe-area').props.edges).toEqual({
      top: 'additive',
      right: 'additive',
      bottom: 'additive',
      left: 'additive',
    });
  });
});

describe('SettingsScreen — 익명 연결 테스트', () => {
  let targetStatus: number;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    targetStatus = 200;
    useSettingsStore.setState({ serverUrl: CURRENT_SERVER_URL });
    useAuthStore.setState({ jwt: 'current-jwt', authRejected: false });
    resetAuthScopeForTest();

    fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/config')) {
        if (url.startsWith(OTHER_SERVER_URL) && targetStatus !== 200) {
          return Promise.resolve(jsonResponse({ detail: 'Unauthorized' }, targetStatus));
        }
        return Promise.resolve(jsonResponse({ mode: 'single', nodeId: 'current' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
    (createApiClient as jest.Mock).mockImplementation(realCreateApiClient);
  });

  it('다른 서버의 401은 Authorization 없이 요청하고 현재 인증을 유지한다', async () => {
    targetStatus = 401;
    const screen = render(
      <SettingsScreen category="connection" showAdmin={false} />,
    );

    fireEvent.changeText(screen.getByTestId('settings-server-input'), OTHER_SERVER_URL);
    fireEvent.press(screen.getByTestId('settings-test-connection'));

    expect(await screen.findByText(/연결 실패: HTTP 401/)).toBeTruthy();
    const targetRequest = fetchMock.mock.calls.find(([input]) =>
      String(input) === `${OTHER_SERVER_URL}/api/config`);
    expect(targetRequest).toBeDefined();
    expect(new Headers(targetRequest?.[1]?.headers).get('Authorization')).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      jwt: 'current-jwt',
      authRejected: false,
    });
  });

  it('다른 서버의 정상 응답은 연결 성공 결과를 표시하고 현재 인증을 유지한다', async () => {
    const screen = render(
      <SettingsScreen category="connection" showAdmin={false} />,
    );

    fireEvent.changeText(screen.getByTestId('settings-server-input'), OTHER_SERVER_URL);
    fireEvent.press(screen.getByTestId('settings-test-connection'));

    expect(await screen.findByText('연결됨: single 모드')).toBeTruthy();
    const targetRequest = fetchMock.mock.calls.find(([input]) =>
      String(input) === `${OTHER_SERVER_URL}/api/config`);
    expect(targetRequest).toBeDefined();
    expect(new Headers(targetRequest?.[1]?.headers).get('Authorization')).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      jwt: 'current-jwt',
      authRejected: false,
    });
  });
});

describe('SettingsScreen — backend node mode 분기', () => {
  it('one selected backend scope supplies both provider sections', async () => {
    mockApi.getConfig.mockResolvedValueOnce({ mode: 'single', nodeId: 'me' });
    const screen = render(<SettingsScreen category="backends"/>);
    expect(await screen.findByText('me')).toBeTruthy();
    expect(screen.getByTestId('backend-provider-claude')).toBeTruthy();
    expect(screen.getByTestId('backend-provider-codex')).toBeTruthy();
  });
  it('배경 설정 컨트롤을 렌더한다', async () => {
    mockApi.getConfig.mockResolvedValueOnce({ mode: 'single', nodeId: 'me' });
    const screen = render(<SettingsScreen category="display" />);

    expect(await screen.findByText('배경')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-wallpaper-photo'));
    expect(await screen.findByText('이미지 업로드')).toBeTruthy();
  });

  it('위젯 데이터 브리지의 기록 여부와 마지막 동기화를 노출한다', async () => {
    mockApi.getConfig.mockResolvedValueOnce({ mode: 'single', nodeId: 'me' });
    const { findByText } = render(<SettingsScreen category="diagnostics" />);

    expect(await findByText('위젯 데이터 브리지')).toBeTruthy();
    expect(await findByText('네이티브 모듈: 사용 가능')).toBeTruthy();
    expect(await findByText('서버 URL: 기록됨')).toBeTruthy();
    expect(await findByText('인증 토큰: 기록됨')).toBeTruthy();
    expect(await findByText(/마지막 동기화:/)).toBeTruthy();
  });

  it('mode=single + nodeId 있음 → backend node 1개 렌더, listNodes 미호출', async () => {
    mockApi.getConfig.mockResolvedValueOnce({ mode: 'single', nodeId: 'me' });
    const { findByText, queryAllByText } = render(<SettingsScreen category="backends" />);
    // 카드의 헤더 노드 텍스트 검증
    expect(await findByText('me')).toBeTruthy();
    // single 모드면 listNodes 호출되지 않아야 한다
    expect(mockApi.listNodes).not.toHaveBeenCalled();
    // 단일 카드만 — '노드: ' 텍스트는 한 번만 등장
    const headers = queryAllByText(/^(me|alpha|beta)$/);
    expect(headers.length).toBe(1);
  });

  it('mode=orchestrator + listNodes 노드 3개 → 선택지 3개 렌더', async () => {
    mockApi.getConfig.mockResolvedValueOnce({
      mode: 'orchestrator',
      nodeId: 'me',
    });
    mockApi.listNodes.mockResolvedValueOnce({
      nodes: [
        { nodeId: 'me' },
        { nodeId: 'alpha' },
        { nodeId: 'beta' },
      ],
    });
    const { findByText, queryAllByText } = render(<SettingsScreen category="backends" />);
    expect(await findByText('me')).toBeTruthy();
    expect(await findByText('alpha')).toBeTruthy();
    expect(await findByText('beta')).toBeTruthy();
    const headers = queryAllByText(/^(me|alpha|beta)$/);
    expect(headers.length).toBe(3);
  });

  it('mode=orchestrator + listNodes 노드 0개 → "연결된 노드가 없습니다" 텍스트', async () => {
    mockApi.getConfig.mockResolvedValueOnce({ mode: 'orchestrator' });
    mockApi.listNodes.mockResolvedValueOnce({ nodes: [] });
    const { findByText } = render(<SettingsScreen category="backends" />);
    expect(await findByText('연결된 노드가 없습니다.')).toBeTruthy();
  });

  it('getConfig pending → ActivityIndicator 표시 (mode=null)', async () => {
    // 절대 resolve되지 않는 promise — mode가 null로 머무름
    mockApi.getConfig.mockReturnValueOnce(new Promise(() => {}));
    const { UNSAFE_queryAllByType } = render(<SettingsScreen category="backends" />);
    // ActivityIndicator를 직접 잡는다 (testID 없이 RN 컴포넌트 type으로 조회)
    await waitFor(() => {
      const RN = require('react-native');
      const indicators = UNSAFE_queryAllByType(RN.ActivityIndicator);
      // "연결 확인" 버튼은 idle 상태에서 ActivityIndicator를 렌더하지 않으므로
      // 적어도 1개는 카드 영역의 mode === null indicator여야 한다.
      expect(indicators.length).toBeGreaterThanOrEqual(1);
    });
  });
});


test('입력 URL이 바뀐 뒤 이전 주소의 연결 테스트 결과를 표시하지 않는다', async () => {
  mockApi.getConfig.mockResolvedValueOnce({ mode: 'single' });
  const screen = render(<SettingsScreen category="connection" showAdmin={false}/>);
  await act(async () => {});
  let resolve!: (value: unknown) => void;
  mockApi.getConfig.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  fireEvent.changeText(screen.getByTestId('settings-server-input'), 'https://before.test');
  fireEvent.press(screen.getByTestId('settings-test-connection'));
  fireEvent.changeText(screen.getByTestId('settings-server-input'), 'https://after.test');
  await act(async () => resolve({ mode: 'single' }));
  expect(screen.queryByText('연결됨: single 모드')).toBeNull();
  expect(screen.getByTestId('settings-server-input').props.value).toBe('https://after.test');
});
