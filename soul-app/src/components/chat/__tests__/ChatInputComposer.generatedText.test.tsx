import React, { createRef } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { Session } from '../../../api/types';
import { useAuthStore } from '../../../store/authStore';
import { useDraftStore } from '../../../store/draftStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { ChatInputComposer, type ChatInputComposerHandle } from '../ChatInputComposer';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const mockClearAttachments = jest.fn();
const mockRestoreAttachments = jest.fn();
const mockRemoveAttachment = jest.fn();
let mockAttachments: Array<{ path: string; name: string }> = [];
let mockUploading = false;
let mockConnectivity = { ready: true, connectedNodeIds: new Set<string>(['node-1']) };
let mockSendState = {
  sending: false,
  hasPendingOptimistic: false,
  sendError: null as string | null,
  handleSend: jest.fn(),
  retryPendingOptimistic: jest.fn(),
  restorePendingOptimistic: jest.fn(),
};

jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: mockAttachments,
    uploading: mockUploading,
    pickAttachment: jest.fn(),
    removeAttachment: mockRemoveAttachment,
    clearAttachments: mockClearAttachments,
    restoreAttachments: mockRestoreAttachments,
  }),
}));

jest.mock('../../../store/nodeConnectivityStore', () => ({
  useNodeConnectivityStore: (selector: (state: typeof mockConnectivity) => unknown) => selector(mockConnectivity),
}));

jest.mock('../useChatSendFlow', () => ({
  CHAT_SEND_ERROR_MESSAGES: { disabled: '메시지를 보낼 수 없습니다.' },
  useChatSendFlow: () => mockSendState,
}));

const jwt = (email: string) => `header.${Buffer.from(JSON.stringify({ email, sub: email, exp: 9999999999 })).toString('base64url')}.signature`;
let sessionSequence = 0;

async function hydrateDraftStores() {
  await Promise.all([
    useAuthStore.persist.rehydrate(),
    useSettingsStore.persist.rehydrate(),
    useDraftStore.persist.rehydrate(),
  ]);
  useAuthStore.setState({ jwt: jwt('composer-p3@example.invalid') });
  useSettingsStore.setState({ serverUrl: 'https://composer-p3.example.invalid' });
}

function renderComposer(options: {
  sessionStatus?: Session['status'];
  generatedNotice?: React.ReactNode;
} = {}) {
  const ref = createRef<ChatInputComposerHandle>();
  const sessionId = `generated-text-${++sessionSequence}`;
  const onComposerLayout = jest.fn();
  const props = {
    sessionId,
    sessionStatus: options.sessionStatus ?? 'completed',
    nodeId: 'node-1',
    backend: 'claude' as const,
    api: { interruptSession: jest.fn() } as unknown as ApiClient,
    detailedNetworkActive: true,
    appForeground: true,
    minimumBottomPadding: 0,
    requestBottomFollow: jest.fn(),
    onComposerLayout,
    generatedNotice: options.generatedNotice,
  };
  const screen = render(<ChatInputComposer ref={ref} {...props} />);
  return { ...screen, ref, props, field: () => screen.getByTestId('chat-composer-text-input') };
}

describe('ChatInputComposer generated text handle', () => {
  beforeEach(async () => {
    await hydrateDraftStores();
    mockAttachments = [];
    mockUploading = false;
    mockConnectivity = { ready: true, connectedNodeIds: new Set(['node-1']) };
    mockSendState = {
      sending: false,
      hasPendingOptimistic: false,
      sendError: null,
      handleSend: jest.fn(),
      retryPendingOptimistic: jest.fn(),
      restorePendingOptimistic: jest.fn(),
    };
    mockClearAttachments.mockClear();
    mockRestoreAttachments.mockClear();
    mockRemoveAttachment.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  test('appends to the latest edited draft, preserving its trailing newline, and empty text is a no-op', () => {
    const screen = renderComposer();
    const before = '가장 최신 초안\n';
    fireEvent.changeText(screen.field(), before);

    let result: unknown;
    act(() => { result = screen.ref.current!.appendGeneratedText(screen.props.sessionId, '생성된 문장'); });

    expect(result).toEqual({ ok: true });
    expect(screen.field().props.value).toBe(`${before}\n\n생성된 문장`);
    expect(screen.field().props.selection).toEqual({ start: `${before}\n\n생성된 문장`.length, end: `${before}\n\n생성된 문장`.length });
    expect(screen.getByTestId('chat-composer-generated-undo-button')).toBeTruthy();

    act(() => { result = screen.ref.current!.appendGeneratedText(screen.props.sessionId, ''); });
    expect(result).toEqual({ ok: true });
    expect(screen.field().props.value).toBe(`${before}\n\n생성된 문장`);
  });

  test('undo restores the exact prior draft and a later edit permanently hides that undo', () => {
    const screen = renderComposer();
    const before = '초안의 끝\n';
    fireEvent.changeText(screen.field(), before);
    act(() => { screen.ref.current!.appendGeneratedText(screen.props.sessionId, '붙인 글'); });

    fireEvent.press(screen.getByTestId('chat-composer-generated-undo-button'));
    expect(screen.field().props.value).toBe(before);
    expect(screen.queryByTestId('chat-composer-generated-undo-button')).toBeNull();

    act(() => { screen.ref.current!.appendGeneratedText(screen.props.sessionId, '붙인 글'); });
    fireEvent.changeText(screen.field(), `${before}\n\n붙인 글!`);
    expect(screen.field().props.value).toBe(`${before}\n\n붙인 글!`);
    expect(screen.queryByTestId('chat-composer-generated-undo-button')).toBeNull();
  });

  test('an empty draft gets only generated text; the notice slot and undo row stay inside the measured anchor', () => {
    const screen = renderComposer({ generatedNotice: <Text testID="generated-notice-fixture">상태 안내</Text> });
    act(() => { screen.ref.current!.appendGeneratedText(screen.props.sessionId, '첫 글'); });

    expect(screen.field().props.value).toBe('첫 글');
    const row = screen.getByTestId('chat-composer-generated-row');
    expect(row.findByProps({ testID: 'generated-notice-fixture' })).toBeTruthy();
    expect(row.findByProps({ testID: 'chat-composer-generated-undo-button' })).toBeTruthy();
    let parent = row.parent;
    while (parent && parent.props.testID !== 'chat-composer-anchor') parent = parent.parent;
    expect(parent).toBeTruthy();
  });

  test('attachments and generated undo share one auxiliary row', () => {
    mockAttachments = [{ path: '/review/file', name: '검수 파일.pdf' }];
    const screen = renderComposer();
    fireEvent.changeText(screen.field(), '초안');
    act(() => { screen.ref.current!.appendGeneratedText(screen.props.sessionId, '생성 글'); });

    const row = screen.getByTestId('chat-composer-generated-row');
    for (const testId of ['chat-attachment-remove-0', 'chat-composer-generated-undo-button']) {
      let descendant: typeof row | null = screen.getByTestId(testId);
      while (descendant && descendant !== row) descendant = descendant.parent;
      expect(descendant).toBe(row);
    }
  });

  test.each([
    ['wrong_session', 'different-session'],
    ['sending', 'current-session'],
    ['disabled', 'current-session'],
    ['not_ready', 'current-session'],
    ['too_long', 'current-session'],
  ] as const)('%s rejects without changing the draft', async (reason, sessionArg) => {
    if (reason === 'sending') mockSendState = { ...mockSendState, sending: true };
    if (reason === 'not_ready') jest.spyOn(useDraftStore.persist, 'hasHydrated').mockReturnValue(false);
    const screen = renderComposer({ sessionStatus: reason === 'disabled' ? 'running' : 'completed' });
    const before = reason === 'not_ready' ? '' : reason === 'too_long' ? 'x'.repeat(4000) : '초안 보존';
    if (before) fireEvent.changeText(screen.field(), before);
    if (reason === 'disabled') {
      mockConnectivity = { ready: true, connectedNodeIds: new Set() };
      screen.rerender(<ChatInputComposer ref={screen.ref} {...screen.props} minimumBottomPadding={1} />);
    }
    const requestedSession = sessionArg === 'different-session' ? sessionArg : screen.props.sessionId;

    let result: unknown;
    act(() => { result = screen.ref.current!.appendGeneratedText(requestedSession, '추가 글'); });

    expect(result).toEqual({ ok: false, reason });
    expect(screen.field().props.value).toBe(before);
    expect(screen.queryByTestId('chat-composer-generated-undo-button')).toBeNull();
  });

  test('append and undo leave attachment and send-flow actions alone', () => {
    mockAttachments = [{ path: '/review/file', name: '검수 파일.pdf' }];
    mockUploading = true;
    const screen = renderComposer();
    fireEvent.changeText(screen.field(), '초안');
    const clearCount = mockClearAttachments.mock.calls.length;
    act(() => { screen.ref.current!.appendGeneratedText(screen.props.sessionId, '생성 글'); });
    fireEvent.press(screen.getByTestId('chat-composer-generated-undo-button'));

    expect(screen.getByText('검수 파일.pdf')).toBeTruthy();
    expect(mockClearAttachments).toHaveBeenCalledTimes(clearCount);
    expect(mockRestoreAttachments).not.toHaveBeenCalled();
    expect(mockRemoveAttachment).not.toHaveBeenCalled();
    expect(mockSendState.handleSend).not.toHaveBeenCalled();
    expect(mockSendState.retryPendingOptimistic).not.toHaveBeenCalled();
    expect(mockSendState.restorePendingOptimistic).not.toHaveBeenCalled();
  });
});
