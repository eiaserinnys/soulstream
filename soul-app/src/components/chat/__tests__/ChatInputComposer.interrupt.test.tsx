import React from 'react';
import { ActivityIndicator, Alert, StyleSheet, type LayoutChangeEvent, type LayoutRectangle } from 'react-native';
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
let mockDraftValue = '초안';
let mockAttachments: Array<{ path: string; name?: string }> = [];
let mockAttachmentsReady = true;
let mockUploading = false;
let mockSendFlowDeps: any;

jest.mock('../../../hooks/usePersistentDraft', () => ({
  usePersistentDraft: () => ({ ready: true, value: mockDraftValue, setValue: mockSetDraft, clear: mockClearDraft }),
}));

jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: mockAttachments,
    attachmentsReady: mockAttachmentsReady,
    uploading: mockUploading,
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
  useChatSendFlow: (deps: any) => {
    mockSendFlowDeps = deps;
    return {
      sending: false,
      hasPendingOptimistic: false,
      sendError: null,
      handleSend: mockHandleSend,
      retryPendingOptimistic: mockRetryPendingOptimistic,
      restorePendingOptimistic: mockRestorePendingOptimistic,
    };
  },
}));

function renderChatInputComposer(
  sessionStatus: string = 'running',
  onComposerLayout?: (anchorLayout: LayoutRectangle, composerBox: LayoutRectangle) => void,
) {
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
    onComposerLayout,
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
    mockDraftValue = '초안';
    mockAttachments = [];
    mockAttachmentsReady = true;
    mockUploading = false;
    mockSendFlowDeps = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test.each(['running', 'idle'])('%s 상태에서 준비된 첨부만 보내고 준비 상태를 전송 훅에 전달한다', (sessionStatus) => {
    mockDraftValue = '';
    mockAttachments = [{ path: '/tmp/attachment.png', name: 'attachment.png' }];
    mockAttachmentsReady = true;
    const screen = renderChatInputComposer(sessionStatus);
    const send = screen.getByTestId('chat-composer-send-button');

    expect(mockSendFlowDeps.attachmentsReady).toBe(true);
    expect(send.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(send);
    expect(mockHandleSend).toHaveBeenCalledTimes(1);
    expect(mockHandleSend).toHaveBeenCalledWith('', expect.any(Function), null);
  });

  test('업로드 중에는 본문이 있어도 전송과 첨부 정리를 시작하지 않는다', () => {
    mockDraftValue = '보낼 본문';
    mockAttachments = [{ path: '/tmp/attachment.png', name: 'attachment.png' }];
    mockAttachmentsReady = false;
    mockUploading = true;
    const screen = renderChatInputComposer('idle');
    const send = screen.getByTestId('chat-composer-send-button');
    const clearCallsBeforePress = mockClearAttachments.mock.calls.length;

    expect(mockSendFlowDeps.attachmentsReady).toBe(false);
    expect(send.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(send);
    expect(mockHandleSend).not.toHaveBeenCalled();
    expect(mockClearAttachments).toHaveBeenCalledTimes(clearCallsBeforePress);
  });

  test('Fabric layout event 재사용 뒤에도 anchor 사각형을 보존한다', () => {
    const onComposerLayout = jest.fn();
    const screen = renderChatInputComposer('running', onComposerLayout);
    const anchor = screen.getByTestId('chat-composer-anchor');
    const composerBox = screen.getByTestId('chat-composer-box');
    let composerRow = composerBox.parent;
    while (composerRow && (typeof composerRow.props.onLayout !== 'function'
      || composerRow.props.onLayout === composerBox.props.onLayout)) {
      composerRow = composerRow.parent;
    }
    expect(composerRow).toBeTruthy();

    const anchorLayout = { x: 0, y: 0, width: 320, height: 810 };
    const rowLayout = { x: 0, y: 0, width: 320, height: 56 };
    const boxLayout = { x: 0, y: 0, width: 320, height: 56 };
    const reusedEvent = { nativeEvent: { layout: anchorLayout } } as unknown as LayoutChangeEvent;

    fireEvent(anchor, 'layout', reusedEvent);
    reusedEvent.nativeEvent.layout = rowLayout;
    fireEvent(composerRow!, 'layout', reusedEvent);
    reusedEvent.nativeEvent.layout = boxLayout;
    fireEvent(composerBox, 'layout', reusedEvent);

    expect(onComposerLayout).toHaveBeenCalledTimes(1);
    expect(onComposerLayout).toHaveBeenCalledWith(anchorLayout, { ...boxLayout, y: 754 });
    const [reportedAnchor, reportedBox] = onComposerLayout.mock.calls[0];
    expect(reportedAnchor.y + reportedBox.y + reportedBox.height).toBe(810);
  });

  test('중단 요청 성공 뒤 세션이 running을 벗어나면 진행 표시를 해제한다', async () => {
    const screen = renderChatInputComposer();
    await pressInterrupt(screen);

    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeTruthy();
    const interruptButton = screen.getByTestId('chat-composer-interrupt-button');
    const busySurface = StyleSheet.flatten(screen.getByTestId('chat-composer-interrupt-visual').props.style);
    expect(interruptButton.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(busySurface.opacity).toBeUndefined();

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
