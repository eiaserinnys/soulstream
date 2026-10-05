import React from 'react';
import { ActivityIndicator, Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import { ChatInputComposer } from '../ChatInputComposer';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const mockInterruptSession = jest.fn();
const mockSetDraft = jest.fn();
const mockClearDraft = jest.fn();
const mockClearAttachments = jest.fn();
const mockHandleSend = jest.fn();
const mockRetryPendingOptimistic = jest.fn();
const mockRestorePendingOptimistic = jest.fn();

jest.mock('../../../hooks/usePersistentDraft', () => ({
  usePersistentDraft: () => ({ ready: true, value: '초안', setValue: mockSetDraft, clear: mockClearDraft }),
}));

jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    uploading: false,
    pickAttachment: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: mockClearAttachments,
    restoreAttachments: jest.fn(),
  }),
}));

jest.mock('../../../store/nodeConnectivityStore', () => ({
  useNodeConnectivityStore: (selector: (state: { ready: boolean; connectedNodeIds: ReadonlySet<string> }) => unknown) =>
    selector({ ready: true, connectedNodeIds: new Set(['node-1']) }),
}));

jest.mock('../useChatSendFlow', () => ({
  CHAT_SEND_ERROR_MESSAGES: { disabled: '메시지를 보낼 수 없습니다.' },
  useChatSendFlow: () => ({
    sending: false,
    hasPendingOptimistic: false,
    sendError: null,
    handleSend: mockHandleSend,
    retryPendingOptimistic: mockRetryPendingOptimistic,
    restorePendingOptimistic: mockRestorePendingOptimistic,
  }),
}));

function renderChatInputComposer(sessionStatus: string = 'running') {
  const api = { interruptSession: mockInterruptSession } as unknown as ApiClient;
  const props = {
    sessionId: 'session-1',
    sessionStatus,
    nodeId: 'node-1',
    backend: 'claude' as const,
    api,
    detailedNetworkActive: true,
    appForeground: true,
    minimumBottomPadding: 0,
    requestBottomFollow: jest.fn(),
  };
  const screen = render(<ChatInputComposer {...props} />);
  return { ...screen, props };
}

async function pressInterrupt(screen: ReturnType<typeof renderChatInputComposer>) {
  await act(async () => {
    fireEvent.press(screen.getByTestId('chat-composer-interrupt-button'));
    await Promise.resolve();
  });
}

describe('ChatInputComposer interrupt progress', () => {
  beforeEach(() => {
    mockInterruptSession.mockReset().mockResolvedValue(undefined);
    mockSetDraft.mockReset();
    mockClearDraft.mockReset();
    mockClearAttachments.mockReset();
    mockHandleSend.mockReset();
    mockRetryPendingOptimistic.mockReset();
    mockRestorePendingOptimistic.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('중단 요청 성공 뒤 세션이 running을 벗어나면 진행 표시를 해제한다', async () => {
    const screen = renderChatInputComposer();
    await pressInterrupt(screen);

    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeTruthy();
    expect(screen.getByTestId('chat-composer-interrupt-button').props.accessibilityState.disabled).toBe(true);

    screen.rerender(<ChatInputComposer {...screen.props} sessionStatus="completed" />);
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();

    screen.rerender(<ChatInputComposer {...screen.props} sessionStatus="running" />);
    expect(screen.getByTestId('chat-composer-interrupt-button').props.accessibilityState.disabled).toBe(false);
  });

  test('running 상태가 유지되면 성공 후 10초에 중단 버튼을 다시 활성화한다', async () => {
    jest.useFakeTimers();
    const screen = renderChatInputComposer();
    await pressInterrupt(screen);

    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeTruthy();
    act(() => { jest.advanceTimersByTime(9_999); });
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeTruthy();

    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
    expect(screen.getByTestId('chat-composer-interrupt-button').props.accessibilityState.disabled).toBe(false);
  });

  test('중단 요청 실패는 진행 표시를 해제하고 기존 알림을 보인다', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockInterruptSession.mockRejectedValueOnce(new Error('연결 오류'));
    const screen = renderChatInputComposer();

    await pressInterrupt(screen);

    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
    expect(screen.getByTestId('chat-composer-interrupt-button').props.accessibilityState.disabled).toBe(false);
    expect(alert).toHaveBeenCalledWith('중단 실패', '연결 오류');
  });

  test('진행 중인 중단 타이머는 상태 변경과 언마운트 때 정리한다', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const screen = renderChatInputComposer();
    await pressInterrupt(screen);
    const getReleaseTimeouts = () => setTimeoutSpy.mock.results
      .map((result, index) => ({ delay: setTimeoutSpy.mock.calls[index][1], id: result.value }))
      .filter(timer => timer.delay === 10_000);
    const firstReleaseTimeout = getReleaseTimeouts()[0]?.id;
    expect(firstReleaseTimeout).toBeDefined();

    screen.rerender(<ChatInputComposer {...screen.props} sessionStatus="completed" />);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(firstReleaseTimeout);

    screen.rerender(<ChatInputComposer {...screen.props} sessionStatus="running" />);
    await pressInterrupt(screen);
    const releaseTimeouts = getReleaseTimeouts();
    const unmountReleaseTimeout = releaseTimeouts[releaseTimeouts.length - 1]?.id;
    expect(releaseTimeouts).toHaveLength(2);
    screen.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(unmountReleaseTimeout);
  });
});
