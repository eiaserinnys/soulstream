import React from 'react';
import { AppState, Pressable, TextInput, View } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockRenderChatEventList = jest.fn();
const mockRenderChatComposer = jest.fn();
const mockRenderChatRow = jest.fn();
let mockRealChatEventList = false;
const mockApiClient = {
  sessionEventsUrl: jest.fn(() => 'https://server.test/api/sessions/sess-1/events'),
  getSessionsByIds: jest.fn().mockResolvedValue([]),
  getPersistentSession: jest.fn().mockResolvedValue({ session: { persistent: false, settings: {} } }),
  intervene: jest.fn(),
};
let mockSendPromise: Promise<void> | undefined;
let mockRestorePendingEventId: string | undefined;
const mockRenderRealtimeVoiceControls = jest.fn((_props: unknown) => null);
const mockUseChatAttachments = jest.fn((_options?: unknown) => ({
  attachments: [],
  uploading: false,
  pickAttachment: jest.fn(),
  removeAttachment: jest.fn(),
  clearAttachments: jest.fn(),
  restoreAttachments: jest.fn(),
}));
const mockUseChatSendFlow = jest.fn((_options?: unknown) => ({
  sending: false,
  sendError: null,
  handleSend: jest.fn(),
}));
const mockHistoryLoadingRef = { current: false };
const mockRequestOlder = jest.fn();
const mockHistoryState = {
  current: {
    historyLoading: false,
    reachedTop: true,
    mvcpEnabled: true,
    hasFetchError: false,
  },
};
const mockUseChatHistoryPagination = jest.fn((_options: unknown) => ({
  ...mockHistoryState.current,
  retryFromError: jest.fn(),
  requestOlder: mockRequestOlder,
  onScroll: jest.fn(),
  historyLoadingRef: mockHistoryLoadingRef,
}));

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

jest.mock('../ChatEventList', () => {
  const React = require('react');
  const { Pressable, View } = require('react-native');
  return {
    ChatEventList: (props: any) => {
      mockRenderChatEventList(props);
      if (mockRealChatEventList) return React.createElement(jest.requireActual('../ChatEventList').ChatEventList, props);
      return React.createElement(
        View,
        { testID: 'chat-event-list' },
        React.createElement(Pressable, {
          testID: 'chat-event-list-restore-pending',
          onPress: () => props.onRestorePending(mockRestorePendingEventId),
        }),
      );
    },
  };
});

jest.mock('../ChatRuntimeStrips', () => ({
  ChatRuntimeStrips: () => require('react').createElement(require('react-native').View, { testID: 'chat-runtime-strips' }),
}));

jest.mock('../SessionStoryPanel', () => ({
  SessionStoryPanel: () => require('react').createElement(require('react-native').View, { testID: 'session-story-panel' }),
}));

jest.mock('../ChatComposer', () => {
  const React = require('react');
  const { Pressable, TextInput, View } = require('react-native');
  return {
    ChatComposer: (props: any) => {
      mockRenderChatComposer(props);
      const [stacked, setStacked] = React.useState(false);
      React.useEffect(() => {
        if (!props.input) setStacked(false);
        else if (props.input.includes('\n')) setStacked(true);
      }, [props.input]);
      return React.createElement(
        View,
        {
          testID: 'chat-composer',
          accessibilityState: { disabled: props.disabled },
        },
        React.createElement(View, {
          testID: 'chat-composer-content-row',
          style: { flexWrap: stacked ? 'wrap' : 'nowrap' },
        }),
        props.interruptControls,
        React.createElement(TextInput, {
          testID: 'chat-composer-input',
          value: props.input,
          onChangeText: props.onChangeInput,
          editable: !props.disabled,
        }),
        React.createElement(Pressable, {
          testID: 'chat-send-button',
          onPress: () => {
            mockSendPromise = props.onSend();
          },
        }),
      );
    },
  };
});

jest.mock('../AttachmentChips', () => ({
  AttachmentChips: () => null,
}));

jest.mock('../ChatInterruptButton', () => ({
  ChatInterruptButton: () => require('react').createElement(require('react-native').View, { testID: 'test-chat-interrupt' }),
}));
jest.mock('../../events/EventRenderer', () => ({ EventRenderer: (props: any) => { mockRenderChatRow(props); return null; } }));
jest.mock('../../events/ToolEvent', () => ({ ToolEvent: (props: any) => { mockRenderChatRow(props); return null; } }));
jest.mock('../../events/EventContextMenu', () => ({ EventContextMenu: ({ children }: any) => children }));
jest.mock('../TypingIndicator', () => ({ TypingIndicator: (props: any) => { mockRenderChatRow(props); return require('react').createElement(require('react-native').Text, { testID: 'test-chat-running' }, '생각 중'); } }));

jest.mock('../RealtimeVoiceControls', () => ({
  RealtimeVoiceControls: (props: unknown) => mockRenderRealtimeVoiceControls(props),
}));

jest.mock('../../../hooks/useSSEStream', () => ({
  SESSION_EVENT_TYPES: ['history_sync'],
  useSSEStream: jest.fn(),
}));

jest.mock('../../../api/client', () => ({ createApiClient: () => mockApiClient }));

jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: (options: unknown) => mockUseChatAttachments(options),
}));

jest.mock('../useChatHistoryPagination', () => ({
  useChatHistoryPagination: (options: unknown) =>
    mockUseChatHistoryPagination(options),
}));

jest.mock('../useChatSendFlow', () => ({
  useChatSendFlow: (options: unknown) => mockUseChatSendFlow(options),
}));

import { ChatBody } from '../ChatBody';
import { useSSEStream } from '../../../hooks/useSSEStream';
import { useChatStore } from '../../../store/chatStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';
import { useAuthStore } from '../../../store/authStore';
import { useDraftStore } from '../../../store/draftStore';
import { useUIStore } from '../../../store/uiStore';
import { PERSISTENT_HISTORY_EVENT_TYPES } from '../../../api/persistentHistoryEventTypes';

const realUseChatSendFlow = jest.requireActual('../useChatSendFlow').useChatSendFlow as
  typeof import('../useChatSendFlow').useChatSendFlow;

const SID = 'sess-chatbody-subscription';
const OTHER_SID = 'sess-other';
const originalMergeEvents = useChatStore.getState().mergeEvents;
const originalSetStreamingEvent = useChatStore.getState().setStreamingEvent;
const originalReplaceAssistantStreamingEvents =
  useChatStore.getState().replaceAssistantStreamingEvents;
const originalClearStreamingEvents = useChatStore.getState().clearStreamingEvents;
const originalClearStreamingEvent = useChatStore.getState().clearStreamingEvent;

function fireAppState(state: 'active' | 'background' | 'inactive') {
  (AppState as { currentState: string }).currentState = state;
  for (const listener of (globalThis as any).__appStateListeners ?? []) {
    listener(state);
  }
}

function resetStores() {
  (AppState as { currentState: string }).currentState = 'active';
  useChatStore.setState({
    eventsBySession: {},
    lastEventIdBySession: {},
    pendingFirstMessageBySession: {},
    pendingOptimisticBySession: {},
    streamingSlotsBySession: {},
    mergeEvents: originalMergeEvents,
    setStreamingEvent: originalSetStreamingEvent,
    replaceAssistantStreamingEvents: originalReplaceAssistantStreamingEvents,
    clearStreamingEvents: originalClearStreamingEvents,
    clearStreamingEvent: originalClearStreamingEvent,
  });
  useSessionStore.setState({
    sessions: {
      [SID]: {
        agentSessionId: SID,
        nodeId: 'node-1',
        displayName: 'Test session',
        status: 'idle',
        createdAt: '2026-05-23T00:00:00Z',
        updatedAt: '2026-05-23T00:00:00Z',
      },
    },
    catalog: { folders: [], sessions: {} },
    feedMembership: {},
    feedSessionIds: [],
    catalogReady: false,
  });
  useSettingsStore.setState({
    serverUrl: 'https://server.test',
    serverType: 'soul-server',
    nodeId: 'node-1',
    appearance: 'dark',
  });
  useNodeConnectivityStore.getState().reset();
}

async function preparePersistentChatDrafts() {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({
    jwt: `header.${Buffer.from(JSON.stringify({ email: 'chat@example.com', sub: 'chat@example.com', exp: 9999999999 })).toString('base64url')}.signature`,
  });
  useSettingsStore.setState({ serverUrl: 'https://chat.example' });
  useDraftStore.setState({ drafts: {} });
}

function persistentChatDraftKey(sessionId: string) {
  // In this harness ChatBody's draft target can lack session node metadata at mount.
  const nodeId = useSessionStore.getState().sessions[sessionId]?.nodeId;
  return JSON.stringify(['https://chat.example', 'chat@example.com', 'chat', [nodeId ?? null, sessionId]]);
}

async function renderSettled() {
  const view = render(
    <View>
      <ChatBody sessionId={SID} />
    </View>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  mockRenderChatEventList.mockClear();
  return view;
}

function latestSseOptions() {
  const mockUseSSEStream = useSSEStream as jest.Mock;
  const latestCall = mockUseSSEStream.mock.calls.at(-1);
  if (!latestCall) throw new Error('useSSEStream was not called');
  return latestCall[0] as {
    onOpen?: () => void;
    onSuspending?: () => void;
    onEvent: (type: string, data: unknown, eid: string) => void;
    connectionKey?: string;
    consumerFailureRef?: { current: (error: unknown) => void };
  };
}

describe('ChatBody store subscription boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealChatEventList = false;
    mockSendPromise = undefined;
    mockRestorePendingEventId = undefined;
    mockUseChatSendFlow.mockImplementation(() => ({
      sending: false,
      sendError: null,
      handleSend: jest.fn(),
    }));
    mockApiClient.intervene.mockReset();
    mockApiClient.getSessionsByIds.mockReset().mockResolvedValue([]);
    mockHistoryState.current = {
      historyLoading: false,
      reachedTop: true,
      mvcpEnabled: true,
      hasFetchError: false,
    };
    mockHistoryLoadingRef.current = false;
    resetStores();
    useChatStore.getState().clearPersistentDisplaySettings();
    mockApiClient.getPersistentSession.mockReset().mockResolvedValue({ session: { persistent: false, settings: {} } });
    mockRenderRealtimeVoiceControls.mockClear();
  });

  test('PAS 초기 조회는 저장 응답과 같은 다섯 표시 키를 전달한다', async () => {
    mockApiClient.getPersistentSession.mockResolvedValue({ session: { persistent: true, settings: {
      show_character: false, animate_character: false, show_generation_separator: true,
      show_jev_candidates: true, turn_usage_mode: 'hidden',
    } } });
    const view = await renderSettled();
    expect(useChatStore.getState().persistentDisplaySettingsBySession[SID]?.settings).toEqual({
      show_character: false, animate_character: false, show_generation_separator: true,
      show_jev_candidates: true, turn_usage_mode: 'hidden',
    });
    view.unmount();
  });

  test('session auxiliary visibility defaults on and PAS can omit both story and runtime strips', async () => {
    const view = await renderSettled();
    expect(view.getByTestId('session-story-panel')).toBeTruthy();
    expect(view.getByTestId('chat-runtime-strips')).toBeTruthy();

    view.rerender(<View><ChatBody sessionId={SID} showSessionAuxiliary={false} /></View>);
    expect(view.queryByTestId('session-story-panel')).toBeNull();
    expect(view.queryByTestId('chat-runtime-strips')).toBeNull();
    expect(view.getByTestId('chat-composer-input')).toBeTruthy();
    view.unmount();
  });

  test('일반 세션 초기 조회의 표시 설정은 null이다', async () => {
    const view = await renderSettled();
    expect(useChatStore.getState().persistentDisplaySettingsBySession[SID]?.settings).toBeNull();
    view.unmount();
  });

  test('세션 없는 빈 ChatBody는 다른 세션의 표시 설정을 지우지 않는다', async () => {
    const assignedSessionId = 'assigned-overlay-session';
    const settings = { show_character: true, animate_character: false, show_generation_separator: true,
      show_jev_candidates: false, turn_usage_mode: 'collapsed' as const };
    const store = useChatStore.getState();
    const requestId = store.beginPersistentDisplaySettingsLoad(assignedSessionId);
    store.finishPersistentDisplaySettingsLoad(assignedSessionId, requestId, settings);
    const view = render(<View><ChatBody sessionId={undefined} /></View>);
    await act(async () => { await Promise.resolve(); });

    expect(useChatStore.getState().persistentDisplaySettingsBySession[assignedSessionId]?.settings).toEqual(settings);
    view.unmount();
  });

  test('같은 세션의 보조 ChatBody는 SSE를 열지 않고 공유 streaming 상태를 정리하지 않는다', async () => {
    const clearStreamingEvents = jest.fn(useChatStore.getState().clearStreamingEvents);
    const clearStreamingEvent = jest.fn(useChatStore.getState().clearStreamingEvent);
    useChatStore.setState({ clearStreamingEvents, clearStreamingEvent });

    const view = render(<View><ChatBody sessionId={SID} active ownsSessionConnection={false} /></View>);
    await act(async () => { await Promise.resolve(); });

    expect((useSSEStream as jest.Mock).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ enabled: false }));
    expect(mockUseChatHistoryPagination.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ active: false }));
    view.unmount();
    expect(clearStreamingEvents).not.toHaveBeenCalled();
    expect(clearStreamingEvent).not.toHaveBeenCalled();
  });

  test('세션 ID 없는 ChatBody가 담당 세션 ID를 받아도 PAS 표시 설정을 보존한다', async () => {
    const pasSessionId = 'pas-background-session';
    const settings = { show_character: false, animate_character: true, show_generation_separator: true,
      show_jev_candidates: false, turn_usage_mode: 'collapsed' as const };
    const store = useChatStore.getState();
    const requestId = store.beginPersistentDisplaySettingsLoad(pasSessionId);
    store.finishPersistentDisplaySettingsLoad(pasSessionId, requestId, settings);
    const view = render(<View><ChatBody sessionId={undefined} /></View>);
    await act(async () => { await Promise.resolve(); });

    view.rerender(<View><ChatBody sessionId={SID} /></View>);
    await act(async () => { await Promise.resolve(); });

    expect(useChatStore.getState().persistentDisplaySettingsBySession[pasSessionId]?.settings).toEqual(settings);
    view.unmount();
  });

  test('비활성 중 표시 설정과 입력 초안을 보존하고 재활성 때 다시 조회한다', async () => {
    mockApiClient.getPersistentSession.mockResolvedValue({ session: { persistent: true, settings: {
      show_character: true, animate_character: false, show_generation_separator: true,
      show_jev_candidates: false, turn_usage_mode: 'collapsed',
    } } });
    const view = await renderSettled();
    fireEvent.changeText(view.getByTestId('chat-composer-input'), '작성 중인 문장');
    const saved = useChatStore.getState().persistentDisplaySettingsBySession[SID];
    view.rerender(<View><ChatBody sessionId={SID} active={false} /></View>);
    expect(useChatStore.getState().persistentDisplaySettingsBySession[SID]).toEqual(saved);
    expect(mockApiClient.getPersistentSession).toHaveBeenCalledTimes(1);
    let resolveReload!: (value: unknown) => void;
    mockApiClient.getPersistentSession.mockReturnValueOnce(new Promise(resolve => { resolveReload = resolve; }));
    view.rerender(<View><ChatBody sessionId={SID} active /></View>);
    expect(useChatStore.getState().persistentDisplaySettingsBySession[SID]?.settings).toEqual(saved?.settings);
    await act(async () => { resolveReload({ session: { persistent: true, settings: {
      show_character: false, animate_character: true, show_generation_separator: false,
      show_jev_candidates: true, turn_usage_mode: 'hidden',
    } } }); });
    expect(mockApiClient.getPersistentSession).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().persistentDisplaySettingsBySession[SID]?.settings).toEqual({
      show_character: false, animate_character: true, show_generation_separator: false,
      show_jev_candidates: true, turn_usage_mode: 'hidden',
    });
    expect(view.getByTestId('chat-composer-input').props.value).toBe('작성 중인 문장');
    view.unmount();
  });

  test('비활성 상태에서도 세션 변경과 API 제거는 이전 표시 설정을 지운다', async () => {
    mockApiClient.getPersistentSession.mockResolvedValue({ session: { persistent: true, settings: {} } });
    const view = await renderSettled();
    view.rerender(<View><ChatBody sessionId={OTHER_SID} active={false} /></View>);
    expect(useChatStore.getState().persistentDisplaySettingsBySession[SID]).toBeUndefined();
    view.rerender(<View><ChatBody sessionId={OTHER_SID} active /></View>);
    await act(async () => { await Promise.resolve(); });
    expect(useChatStore.getState().persistentDisplaySettingsBySession[OTHER_SID]?.sessionId).toBe(OTHER_SID);
    await act(async () => { useSettingsStore.setState({ serverUrl: '' }); });
    expect(useChatStore.getState().persistentDisplaySettingsBySession).toEqual({});
    view.unmount();
  });

  test('원고형 표시를 목록과 입력에 전달하고 입력 묶음 배치를 올린다', async () => {
    await preparePersistentChatDrafts();
    const onComposerLayout = jest.fn();
    const view = render(
      <View>
        <ChatBody sessionId={SID} presentation="manuscript" onComposerLayout={onComposerLayout} />
      </View>,
    );

    await act(async () => { await Promise.resolve(); });

    expect(mockRenderChatEventList.mock.calls.at(-1)?.[0].presentation).toBe('manuscript');
    expect(mockRenderChatComposer.mock.calls.at(-1)?.[0].presentation).toBe('manuscript');
    const anchor = view.getByTestId('chat-composer-anchor');
    const singleLineLayout = { nativeEvent: { layout: { x: 0, y: 120, width: 320, height: 76 } } };
    const attachmentLayout = { nativeEvent: { layout: { x: 0, y: 66, width: 320, height: 130 } } };
    const expandedLayout = { nativeEvent: { layout: { x: 0, y: 80, width: 320, height: 203 } } };
    const singleLineBox = { x: 0, y: 0, width: 320, height: 56 };
    const singleLineRow = { x: 0, y: 0, width: 320, height: 76 };
    const expandedBox = { x: 0, y: 0, width: 320, height: 183 };
    const expandedRow = { x: 0, y: 0, width: 320, height: 203 };
    fireEvent(anchor, 'layout', singleLineLayout);
    mockRenderChatComposer.mock.calls.at(-1)?.[0].onComposerBoxLayout(singleLineBox, singleLineRow);
    fireEvent(anchor, 'layout', attachmentLayout);
    fireEvent(anchor, 'layout', expandedLayout);
    mockRenderChatComposer.mock.calls.at(-1)?.[0].onComposerBoxLayout(expandedBox, expandedRow);
    expect(onComposerLayout).toHaveBeenNthCalledWith(1, singleLineLayout.nativeEvent.layout, { ...singleLineBox, y: 0 });
    expect(onComposerLayout).toHaveBeenNthCalledWith(2, attachmentLayout.nativeEvent.layout, { ...singleLineBox, y: 54 });
    expect(onComposerLayout).toHaveBeenLastCalledWith(expandedLayout.nativeEvent.layout, { ...expandedBox, y: 0 });
  });

  test('기본 채팅은 history eventTypes를 생략하고 원고형만 정본 목록과 complete를 요청한다', async () => {
    await preparePersistentChatDrafts();
    const view = render(<View><ChatBody sessionId={SID} /></View>);
    await act(async () => { await Promise.resolve(); });

    const defaultOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(defaultOptions).not.toHaveProperty('timelineEventTypes');

    view.rerender(<View><ChatBody sessionId={SID} presentation="manuscript" /></View>);
    await act(async () => { await Promise.resolve(); });

    const manuscriptOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(manuscriptOptions.timelineEventTypes).toEqual([...PERSISTENT_HISTORY_EVENT_TYPES]);
    view.unmount();
  });

  test('채팅은 캐시에 없는 세션 한 건을 한 번 받아 오고 피드 후보는 늘리지 않는다', async () => {
    await preparePersistentChatDrafts();
    resetStores();
    useSessionStore.setState({ sessions: {}, feedMembership: {}, feedSessionIds: [] });
    mockApiClient.getSessionsByIds.mockResolvedValueOnce([{
      agentSessionId: SID,
      nodeId: 'node-1',
      displayName: 'Hydrated chat session',
      status: 'idle',
      createdAt: '2026-05-23T00:00:00Z',
      updatedAt: '2026-05-23T00:00:00Z',
    }]);

    const view = render(<View><ChatBody sessionId={SID} /></View>);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApiClient.getSessionsByIds).toHaveBeenCalledTimes(1);
    expect(mockApiClient.getSessionsByIds).toHaveBeenCalledWith([SID]);
    expect(useSessionStore.getState().sessions[SID]?.displayName).toBe('Hydrated chat session');
    expect(useSessionStore.getState().feedMembership).not.toHaveProperty(SID);
    expect(useSessionStore.getState().feedSessionIds).toEqual([]);
    view.unmount();
  });

  test('인증 범위가 바뀌면 채팅 세션의 늦은 응답은 버리고 같은 id를 다시 조회한다', async () => {
    await preparePersistentChatDrafts();
    resetStores();
    useSessionStore.setState({ sessions: {}, feedMembership: {}, feedSessionIds: [] });
    let resolveOld!: (rows: any[]) => void;
    let resolveCurrent!: (rows: any[]) => void;
    mockApiClient.getSessionsByIds
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCurrent = resolve; }));

    const view = render(<View><ChatBody sessionId={SID} /></View>);
    await waitFor(() => expect(mockApiClient.getSessionsByIds).toHaveBeenCalledTimes(1));

    act(() => {
      useSettingsStore.setState({ serverUrl: 'https://server-b.test' });
      useSessionStore.setState({ sessions: {}, feedMembership: {}, feedSessionIds: [] });
    });
    await waitFor(() => expect(mockApiClient.getSessionsByIds).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveOld([{
        agentSessionId: SID, displayName: 'Old scope session', status: 'idle',
        createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
      }]);
      await Promise.resolve();
    });
    expect(useSessionStore.getState().sessions[SID]).toBeUndefined();

    await act(async () => {
      resolveCurrent([{
        agentSessionId: SID, displayName: 'Current scope session', status: 'idle',
        createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
      }]);
      await Promise.resolve();
    });
    expect(useSessionStore.getState().sessions[SID]?.displayName).toBe('Current scope session');
    expect(mockApiClient.getSessionsByIds).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().feedMembership).toEqual({});
    expect(useSessionStore.getState().feedSessionIds).toEqual([]);
    view.unmount();
  });

  test('session preview and timestamp updates render neither the composer nor existing rows', async () => {
    await preparePersistentChatDrafts();
    mockRealChatEventList = true;
    useSessionStore.getState().upsertSession({
      agentSessionId: SID, nodeId: 'node-1', displayName: 'Test session', status: 'running',
      createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
    });
    useChatStore.getState().mergeEvents(SID, [
      { id: '1', type: 'user_message', data: { text: '질문' } },
      { id: '2', type: 'assistant_message', data: { text: '답변' } },
      { id: '3', type: 'tool_start', data: { tool_use_id: 'tool', tool_name: 'exec_command' } },
    ]);
    const view = await renderSettled();
    expect(mockRenderChatRow).toHaveBeenCalled();
    mockRenderChatRow.mockClear();
    mockRenderChatComposer.mockClear();
    act(() => useSessionStore.getState().updateSession(SID, {
      lastMessage: { type: 'assistant_message', eventId: 4, preview: '새 미리보기', timestamp: '2026-10-05T04:00:00Z' },
      updatedAt: '2026-10-05T04:00:00Z',
    }));
    expect([mockRenderChatComposer.mock.calls.length, mockRenderChatRow.mock.calls.length]).toEqual([0, 0]);
    act(() => useSessionStore.getState().updateSession(SID, {
      nodeId: 'node-2', agentName: '새 에이전트', backend: 'codex',
    }));
    expect(mockRenderChatComposer).toHaveBeenCalled();
    expect(mockRenderChatComposer.mock.calls.at(-1)?.[0].voiceControls.props.backend).toBe('codex');
    const rowSession = mockRenderChatRow.mock.calls.find(([props]) => props.session)?.[0].session;
    expect(rowSession).toMatchObject({ nodeId: 'node-2', agentName: '새 에이전트' });
    expect(rowSession).not.toHaveProperty('updatedAt');
    expect(rowSession).not.toHaveProperty('lastMessage');
    view.unmount();
  });

  test('running to idle to running keeps interrupt and running indicators in sync', async () => {
    await preparePersistentChatDrafts();
    mockRealChatEventList = true;
    useSessionStore.getState().upsertSession({
      agentSessionId: SID, nodeId: 'node-1', displayName: 'Test session', status: 'running',
      createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
    });
    const view = await renderSettled();
    expect(view.getByTestId('test-chat-interrupt')).toBeTruthy();
    expect(view.getByTestId('test-chat-running')).toBeTruthy();
    act(() => useSessionStore.getState().updateSession(SID, { status: 'idle' }));
    expect(view.queryByTestId('test-chat-interrupt')).toBeNull();
    expect(view.queryByTestId('test-chat-running')).toBeNull();
    act(() => useSessionStore.getState().updateSession(SID, { status: 'running' }));
    expect(view.getByTestId('test-chat-interrupt')).toBeTruthy();
    expect(view.getByTestId('test-chat-running')).toBeTruthy();
    view.unmount();
  });

  test('switching from a long A draft to a nonempty B draft displays only B', async () => {
    await preparePersistentChatDrafts();
    useDraftStore.getState().write(persistentChatDraftKey(SID), '세션 A의 긴 초안\n둘째 줄');
    useDraftStore.getState().write(persistentChatDraftKey(OTHER_SID), 'B 초안');
    const view = await renderSettled();
    expect(view.getByTestId('chat-composer-input').props.value).toBe('세션 A의 긴 초안\n둘째 줄');
    view.rerender(<View><ChatBody sessionId={OTHER_SID} /></View>);
    expect(view.getByTestId('chat-composer-input').props.value).toBe('B 초안');
    view.unmount();
  });

  test('typing updates only the composer, without rendering the conversation list', async () => {
    await preparePersistentChatDrafts();
    const view = await renderSettled();
    fireEvent.changeText(view.getByTestId('chat-composer-input'), '입');
    expect(view.getByTestId('chat-composer-input').props.value).toBe('입');
    expect(mockRenderChatEventList).not.toHaveBeenCalled();
    view.unmount();
  });

  test('live text and history events do not render the input composer', async () => {
    await preparePersistentChatDrafts();
    const view = await renderSettled();
    mockRenderChatComposer.mockClear();
    act(() => useChatStore.getState().setStreamingEvent(SID, 'assistant', {
      id: 'live', type: 'assistant_message', data: { text: '답변', streamIdentity: 'live' },
    }));
    act(() => useChatStore.getState().mergeEvents(SID, [{
      id: '42', type: 'tool_start', data: { tool_use_id: 'tool', tool_name: 'exec_command' },
    }]));
    expect(mockRenderChatComposer).not.toHaveBeenCalled();
    view.unmount();
  });

  test('lastEventIdBySession 변경은 ChatBody 렌더를 유발하지 않는다', async () => {
    await renderSettled();

    act(() => {
      useChatStore.getState().setLastEventId(SID, '101');
    });

    expect(mockRenderChatEventList).not.toHaveBeenCalled();
  });

  test('다른 세션 이벤트 merge는 현재 ChatBody 렌더를 유발하지 않는다', async () => {
    await renderSettled();

    act(() => {
      useChatStore.getState().mergeEvents(OTHER_SID, [
        { id: '1', type: 'assistant_message', data: { content: 'other' } },
      ]);
    });

    expect(mockRenderChatEventList).not.toHaveBeenCalled();
  });

  test('ChatBody mount는 이미 가진 세션 events를 clear하지 않아 blank frame을 만들지 않는다', async () => {
    useChatStore.getState().mergeEvents(SID, [
      { id: '1', type: 'user_message', data: { text: 'cached' } },
    ]);

    const view = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(useChatStore.getState().eventsBySession[SID]).toEqual([
      { id: '1', type: 'user_message', data: { text: 'cached' } },
    ]);
    const latestProps = mockRenderChatEventList.mock.calls.at(-1)?.[0];
    expect(latestProps.items.map((item: any) => item.key)).toContain('evt-1');
    view.unmount();
  });

  test('검색 이벤트를 찾을 때까지 과거 페이지를 요청하고 찾으면 강조한다', async () => {
    mockHistoryState.current = {
      historyLoading: false,
      reachedTop: false,
      mvcpEnabled: true,
      hasFetchError: false,
    };
    const view = render(
      <View>
        <ChatBody sessionId={SID} focusEventId={42} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRequestOlder).toHaveBeenCalledTimes(1);

    act(() => {
      useChatStore.getState().mergeEvents(SID, [
        { id: '900', type: 'user_message', data: { text: 'older page' } },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRequestOlder).toHaveBeenCalledTimes(2);

    act(() => {
      useChatStore.getState().mergeEvents(SID, [
        { id: '42', type: 'user_message', data: { text: 'search result' } },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const latestProps = mockRenderChatEventList.mock.calls.at(-1)?.[0];
    expect(latestProps.items.some((item: any) => item.key.includes('42'))).toBe(true);
    expect(latestProps.highlightedItemKey).not.toBeNull();
    expect(mockRequestOlder).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test('stale focus RAF는 새 세션의 이벤트 완료 콜백을 호출하지 않는다', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelFrame = jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => undefined);
    useChatStore.getState().mergeEvents(SID, [
      { id: '42', type: 'user_message', data: { text: 'first session event' } },
    ]);
    useChatStore.getState().mergeEvents(OTHER_SID, [
      { id: '7', type: 'user_message', data: { text: 'second session event' } },
    ]);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [OTHER_SID]: {
          agentSessionId: OTHER_SID,
          nodeId: 'node-1',
          displayName: 'Other session',
          status: 'idle',
          createdAt: '2026-05-23T00:00:00Z',
          updatedAt: '2026-05-23T00:00:00Z',
        },
      },
    }));
    const staleHandled = jest.fn();
    const latestHandled = jest.fn();
    const view = render(
      <ChatBody sessionId={SID} focusEventId={42} onFocusEventHandled={staleHandled} />,
    );
    await act(async () => { await Promise.resolve(); });
    const staleFrames = callbacks.slice();

    view.rerender(
      <ChatBody sessionId={OTHER_SID} focusEventId={7} onFocusEventHandled={latestHandled} />,
    );
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      staleFrames.forEach((callback) => callback(16));
    });
    expect(staleHandled).not.toHaveBeenCalled();

    await act(async () => {
      callbacks.slice(staleFrames.length).forEach((callback) => callback(32));
    });
    expect(latestHandled).toHaveBeenCalledWith(OTHER_SID, 7);
    view.unmount();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  test('검색 이벤트가 과거 기록에도 없으면 끝에 도달한 상태를 알린다', async () => {
    const view = render(
      <View>
        <ChatBody sessionId={SID} focusEventId={42} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.getByText('검색 결과 이벤트를 대화에서 찾을 수 없습니다.'))
      .toBeTruthy();
    expect(mockRequestOlder).not.toHaveBeenCalled();
    view.unmount();
  });

  test('AppState background → active 복귀는 이미 가진 메시지 데이터를 비우지 않는다', async () => {
    useChatStore.getState().mergeEvents(SID, [
      { id: '1', type: 'assistant_message', data: { content: 'cached' } },
    ]);
    const view = await renderSettled();

    act(() => {
      fireAppState('background');
      fireAppState('inactive');
      fireAppState('active');
    });

    expect(useChatStore.getState().eventsBySession[SID]).toEqual([
      { id: '1', type: 'assistant_message', data: { content: 'cached' } },
    ]);
    const latestProps = mockRenderChatEventList.mock.calls.at(-1)?.[0];
    expect(latestProps.items.map((item: any) => item.key)).toContain('evt-1');
    view.unmount();
  });

  test('active=false는 history와 detailed SSE만 중단하고 사용자 시작 voice 종료 신호는 보내지 않는다', async () => {
    const view = render(
      <View>
        <ChatBody sessionId={SID} active={false} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockUseChatHistoryPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false }),
    );
    expect((useSSEStream as jest.Mock).mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    const composerProps = mockRenderChatComposer.mock.calls.at(-1)?.[0];
    expect(composerProps.voiceControls.props.disabled).toBe(false);
    view.unmount();
  });

  test('Control Center inactive만으로 detailed active가 꺼지지 않고 background 동안만 중단된다', async () => {
    const view = await renderSettled();
    expect(mockUseChatHistoryPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true }),
    );

    act(() => {
      fireAppState('inactive');
    });
    expect(mockUseChatHistoryPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true }),
    );

    act(() => {
      fireAppState('background');
    });
    expect(mockUseChatHistoryPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false }),
    );

    act(() => {
      fireAppState('inactive');
    });
    expect(mockUseChatHistoryPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false }),
    );

    act(() => {
      fireAppState('active');
    });
    expect(mockUseChatHistoryPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true }),
    );
    view.unmount();
  });

  test('thinking delta 수신 직후 active=false는 미커밋 cursor를 넘기지 않고 transient slot을 버린다', async () => {
    jest.useFakeTimers();
    try {
      const view = await renderSettled();
      const sse = latestSseOptions();

      act(() => {
        sse.onOpen?.();
        sse.onEvent('history_sync', { is_live: true, last_event_id: 100 }, '');
        sse.onEvent(
          'thinking_delta',
          {
            thinking: '아직 미커밋',
            item_id: 'thinking-pending',
            raw_event_type: 'item/reasoning/delta',
            _live_only: true,
          },
          '101',
        );
        view.rerender(
          <View>
            <ChatBody sessionId={SID} active={false} />
          </View>,
        );
        jest.runOnlyPendingTimers();
      });

      const state = useChatStore.getState();
      expect(state.lastEventIdBySession[SID]).toBe('100');
      expect(state.streamingSlotsBySession[SID]).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('catchup replay text_delta는 live streaming slot을 만들지 않고 history_sync 후 history 경로로 들어간다', async () => {
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_delta', { text: 'replayed chunk' }, '101');
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().eventsBySession[SID]).toBeUndefined();

    act(() => {
      sse.onEvent('history_sync', { is_live: true, last_event_id: 101 }, '');
    });

    const state = useChatStore.getState();
    expect(state.eventsBySession[SID]).toEqual([
      { id: '101', type: 'text_delta', data: { text: 'replayed chunk' } },
    ]);
    expect(state.lastEventIdBySession[SID]).toBe('101');
  });

  test('catchup replay text_delta는 history_sync 전까지 store에 건별 merge되지 않고 sync 후 batch로 들어간다', async () => {
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_delta', { text: 'first replay' }, '101');
      sse.onEvent('text_delta', { text: 'second replay' }, '102');
    });

    expect(useChatStore.getState().eventsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();

    act(() => {
      sse.onEvent('history_sync', { is_live: true, last_event_id: 102 }, '');
    });

    const state = useChatStore.getState();
    expect(state.eventsBySession[SID]?.map((event) => event.id)).toEqual([
      '101',
      '102',
    ]);
    expect(state.lastEventIdBySession[SID]).toBe('102');
  });

  test('catchup 중 state-only 이벤트는 앞선 미커밋 chat event를 넘는 cursor를 만들지 않는다', async () => {
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_delta', { text: 'queued replay' }, '101');
      sse.onEvent(
        'claude_runtime_mode_state',
        { mode: 'plan', active: true },
        '102',
      );
    });

    expect(useChatStore.getState().lastEventIdBySession[SID]).toBeUndefined();

    act(() => {
      sse.onEvent('history_sync', { is_live: true, last_event_id: 102 }, '');
    });
    expect(useChatStore.getState().eventsBySession[SID]?.map((event) => event.id))
      .toEqual(['101']);
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('102');
  });

  test('live runtime cursor는 pending thinking delta commit을 추월하지 않는다', async () => {
    jest.useFakeTimers();
    try {
      const view = await renderSettled();
      const sse = latestSseOptions();
      act(() => {
        sse.onOpen?.();
        sse.onEvent('history_sync', {
          type: 'history_sync',
          last_event_id: 20,
          is_live: true,
          reset_required: false,
        }, '');
        sse.onEvent('thinking_delta', {
          type: 'thinking_delta',
          thinking: 'committed before runtime',
          _live_only: true,
        }, '21');
        sse.onEvent('claude_runtime_mode_state', {
          type: 'claude_runtime_mode_state',
          mode: 'plan',
          active: true,
        }, '22');
      });

      expect(useChatStore.getState().streamingSlotsBySession[SID]
        ?.thinking?.data.thinking).toBe('committed before runtime');
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('22');

      act(() => {
        view.rerender(
          <View>
            <ChatBody sessionId={SID} active={false} />
          </View>,
        );
        jest.runOnlyPendingTimers();
      });
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('22');
    } finally {
      jest.useRealTimers();
    }
  });

  test('history_sync last_event_id를 반영한 뒤 live-only text_delta만 즉시 streaming slot에 표시한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 200 }, '');
      sse.onEvent(
        'text_delta',
        {
          text: 'live',
          item_id: 'item-live',
          raw_event_type: 'item/agentMessage/delta',
          _live_only: true,
        },
        '200',
      );
    });

    const state = useChatStore.getState();
    expect(state.lastEventIdBySession[SID]).toBe('200');
    expect(state.eventsBySession[SID]).toBeUndefined();
    expect(state.streamingSlotsBySession[SID]?.assistant?.data.text).toBe('live');
  });

  test('legacy live slot은 동일 본문의 실제 chunk를 보존하고 동일 payload 재수신만 dedupe한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const payload = {
      type: 'text_delta',
      text: 'x',
      item_id: 'item-legacy-repeat',
      raw_event_type: 'item/agentMessage/delta',
      _live_only: true,
    };

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 200 }, '');
      sse.onEvent('text_delta', { ...payload, timestamp: 100.001 }, '200');
      sse.onEvent('text_delta', { ...payload, timestamp: 100.002 }, '200');
      sse.onEvent('text_delta', { ...payload, timestamp: 100.002 }, '200');
    });

    const state = useChatStore.getState();
    expect(state.eventsBySession[SID]).toBeUndefined();
    expect(state.streamingSlotsBySession[SID]?.assistant?.data.text).toBe('xx');
    expect(state.lastEventIdBySession[SID]).toBe('200');
  });

  test('v2 text snapshot prefix 뒤 seq boundary를 버리고 다음 append를 정확히 한 번 합친다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_app_server:dGhyZWFkLTE:dHVybi0y:aXRlbS0z';

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 1003,
        throughLiveSeq: 41,
        streams: [{
          streamIdentity,
          text: 'prefix already captured',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 1003,
        is_live: true,
        reset_required: false,
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' already captured',
        streamIdentity,
        liveSeq: 41,
        liveTextMode: 'append',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' then live',
        streamIdentity,
        liveSeq: 42,
        liveTextMode: 'append',
      }, '');
    });

    const state = useChatStore.getState();
    expect(state.streamingSlotsBySession[SID]?.assistantByStream?.[streamIdentity]
      ?.data.text).toBe('prefix already captured then live');
    expect(state.eventsBySession[SID]).toBeUndefined();
    expect(state.lastEventIdBySession[SID]).toBe('1003');
  });

  test('REST history loading 중에도 v2 live text는 history 배열이 아닌 recovered slot을 갱신한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_sdk:aXRlbS0x';

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 50,
        throughLiveSeq: 7,
        streams: [{
          streamIdentity,
          text: 'old',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 50,
        is_live: true,
        reset_required: false,
      }, '');
      mockHistoryLoadingRef.current = true;
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: 'new cumulative',
        streamIdentity,
        liveSeq: 8,
        liveTextMode: 'replace',
      }, '51');
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantByStream?.[streamIdentity]?.data.text).toBe('new cumulative');
    expect(useChatStore.getState().eventsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');
    mockHistoryLoadingRef.current = false;
  });

  test('text snapshot durable baseline이 history_sync와 다르면 partial을 승격하지 않는다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_sdk:stale-baseline';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 49,
        throughLiveSeq: 7,
        streams: [{
          streamIdentity,
          text: 'stale partial',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 50,
        is_live: true,
        reset_required: false,
      }, '');
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');
  });

  test('history gap reset은 timeline commit 전 기존 prefix와 suffix를 노출하지 않는다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_app_server:history-gap';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 50,
        throughLiveSeq: 7,
        streams: [{
          streamIdentity,
          text: 'unsafe prefix',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 50,
        is_live: true,
        reset_required: true,
        reset_reason: 'history_gap',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' suffix without prefix',
        streamIdentity,
        liveSeq: 8,
        liveTextMode: 'append',
      }, '');
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().eventsBySession[SID]).toBeUndefined();
  });

  test('history gap reset은 정상 snapshot을 timeline commit 뒤 복원하고 queued append를 한 번만 합친다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_app_server:history-gap-recovery';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 50,
        throughLiveSeq: 7,
        streams: [{
          streamIdentity,
          text: 'safe prefix',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 50,
        is_live: true,
        reset_required: true,
        reset_reason: 'history_gap',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' must not duplicate',
        streamIdentity,
        liveSeq: 7,
        liveTextMode: 'append',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' + queued live',
        streamIdentity,
        liveSeq: 8,
        liveTextMode: 'append',
      }, '');
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    act(() => {
      historyOptions.onInitialPageCommitted(SID);
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantByStream?.[streamIdentity]?.data.text).toBe(
        'safe prefix + queued live',
      );
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');
  });

  test('reset recovery commit 실패는 cursor를 넘기지 않고 상세 SSE를 즉시 재시작한다', async () => {
    await renderSettled();
    const failure = new Error('reset recovery commit failed');
    act(() => {
      useChatStore.setState({
        replaceAssistantStreamingEvents: jest.fn(() => { throw failure; }),
      });
    });
    const sse = latestSseOptions();
    const failConnection = jest.fn();
    if (!sse.consumerFailureRef) throw new Error('consumerFailureRef missing');
    sse.consumerFailureRef.current = failConnection;

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 50,
        throughLiveSeq: 7,
        streams: [{
          streamIdentity: 'codex_app_server:commit-failure',
          text: 'must replay',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 50,
        is_live: true,
        reset_required: true,
        reset_reason: 'history_gap',
      }, '');
    });

    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    act(() => { historyOptions.onInitialPageCommitted(SID); });

    expect(failConnection).toHaveBeenCalledWith(failure);
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
  });

  test('history gap reset도 snapshot보다 새 durable replay suffix를 timeline 뒤 복원한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_app_server:reset-durable-race';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 51,
        throughLiveSeq: 7,
        streams: [{
          streamIdentity,
          text: 'safe prefix',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 51,
        is_live: true,
        reset_required: true,
        reset_reason: 'history_gap',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' + durable suffix',
        _event_id: 51,
        item_id: 'item-reset-suffix',
        raw_event_type: 'item/agentMessage/delta',
        _live_only: true,
        streamIdentity,
        liveSeq: 8,
        liveTextMode: 'append',
      }, '51');
    });

    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    act(() => {
      // Production timeline은 hub가 붙이는 v2 metadata 이전의 raw durable payload다.
      useChatStore.getState().mergeEvents(SID, [{
        id: '51',
        type: 'text_delta',
        data: {
          type: 'text_delta',
          text: ' + durable suffix',
          _event_id: 51,
          item_id: 'item-reset-suffix',
          raw_event_type: 'item/agentMessage/delta',
          _live_only: true,
        },
      }]);
      historyOptions.onInitialPageCommitted(SID);
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantByStream?.[streamIdentity]?.data.text).toBe(
        'safe prefix + durable suffix',
      );
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('51');
    const rendered = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(rendered).toHaveLength(1);
    expect(rendered[0].event.data.text).toBe('safe prefix + durable suffix');
  });

  test('history gap reset의 raw durable final과 id 없는 decorated final은 한 행만 남긴다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_sdk:cmVzZXQtZmluYWw';
    const rawFinal = {
      type: 'assistant_message',
      content: 'reset durable final',
      _event_id: 59,
      item_id: 'reset-final',
      _final_for_live_stream: true,
    };
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 60,
        throughLiveSeq: 10,
        streams: [{
          streamIdentity,
          text: 'stale reset partial',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 60,
        is_live: true,
        reset_required: true,
        reset_reason: 'history_gap',
      }, '');
      sse.onEvent('assistant_message', {
        ...rawFinal,
        streamIdentity,
        liveSeq: 11,
        liveTextMode: 'replace',
      // react-native-sse는 id 없는 frame에도 직전 watermark를 전달한다.
      }, '60');
    });

    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    act(() => {
      useChatStore.getState().mergeEvents(SID, [{
        id: '59',
        type: 'assistant_message',
        data: rawFinal,
      }]);
      // 실제 history hook은 first-page callback 직후 finally에서 false+queue flush한다.
      // 이 mock은 finally가 없으므로 recovery callback 전에 같은 committed 상태를 맞춘다.
      mockHistoryLoadingRef.current = false;
      historyOptions.onInitialPageCommitted(SID);
    });

    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(1);
    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    const rendered = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(rendered).toHaveLength(1);
    expect(rendered[0].event.data.content).toBe('reset durable final');
  });

  test('history gap reset 뒤에도 capped stream만 final 대기하고 정상 stream은 즉시 복원한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const normalIdentity = 'codex_app_server:normal-after-gap';
    const cappedIdentity = 'codex_app_server:capped-after-gap';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 60,
        throughLiveSeq: 10,
        streams: [{
          streamIdentity: normalIdentity,
          text: 'normal prefix',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }, {
          streamIdentity: cappedIdentity,
          text: null,
          updatedAt: '2026-08-06T00:00:06.000Z',
          truncated: true,
          resetRequired: true,
          recovery: 'durable_final',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 60,
        is_live: true,
        reset_required: true,
        reset_reason: 'history_gap',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: 'must remain hidden',
        streamIdentity: cappedIdentity,
        liveSeq: 11,
        liveTextMode: 'append',
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' + live',
        streamIdentity: normalIdentity,
        liveSeq: 12,
        liveTextMode: 'append',
      }, '');
    });

    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    act(() => {
      historyOptions.onInitialPageCommitted(SID);
    });

    const recovered = useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantByStream;
    expect(recovered?.[normalIdentity]?.data.text).toBe('normal prefix + live');
    expect(recovered?.[cappedIdentity]).toBeUndefined();
  });

  test('snapshot 캡처 뒤 durable replay에 포함된 더 높은 liveSeq suffix를 다시 합친다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_app_server:durable-race-suffix';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' + durable suffix',
        _event_id: 70,
        item_id: 'item-durable-suffix',
        raw_event_type: 'item/agentMessage/delta',
        _live_only: true,
      }, '70');
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 70,
        throughLiveSeq: 41,
        streams: [{
          streamIdentity,
          text: 'snapshot prefix',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 70,
        is_live: true,
        reset_required: false,
      }, '');
      // 7caf0414 producer는 snapshot 경계 뒤 tail을 marker 다음에 의미 재방출한다.
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: ' + durable suffix',
        _event_id: 70,
        item_id: 'item-durable-suffix',
        raw_event_type: 'item/agentMessage/delta',
        _live_only: true,
        streamIdentity,
        liveSeq: 42,
        liveTextMode: 'append',
      }, '70');
    });

    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(1);
    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantByStream?.[streamIdentity]?.data.text).toBe(
        'snapshot prefix + durable suffix',
      );
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('70');
    const rendered = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(rendered).toHaveLength(1);
    expect(rendered[0].event.data.text).toBe(
      'snapshot prefix + durable suffix',
    );

    act(() => {
      sse.onEvent('assistant_message', {
        type: 'assistant_message',
        content: 'complete response',
        _event_id: 71,
        item_id: 'item-durable-suffix',
        _final_for_live_stream: true,
        streamIdentity,
        liveSeq: 43,
        liveTextMode: 'append',
      }, '71');
    });

    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    const finalized = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(finalized).toHaveLength(1);
    expect(finalized[0].event.data.content).toBe('complete response');
  });

  test('snapshot 캡처 뒤 durable final은 stale snapshot partial을 다시 노출하지 않는다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_app_server:durable-race-final';
    act(() => {
      sse.onOpen?.();
      sse.onEvent('assistant_message', {
        type: 'assistant_message',
        content: 'durable final',
        _event_id: 79,
        item_id: 'item-durable-final',
        _final_for_live_stream: true,
      }, '79');
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 80,
        throughLiveSeq: 51,
        streams: [{
          streamIdentity,
          text: 'stale partial',
          updatedAt: '2026-08-06T00:00:05.000Z',
          truncated: false,
          resetRequired: false,
          recovery: 'none',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 80,
        is_live: true,
        reset_required: false,
      }, '');
      // 과거 durable ID(79)는 server가 cursor 역행 방지를 위해 id 없이 재방출한다.
      sse.onEvent('assistant_message', {
        type: 'assistant_message',
        content: 'durable final',
        _event_id: 79,
        item_id: 'item-durable-final',
        streamIdentity,
        liveSeq: 52,
        liveTextMode: 'append',
        _final_for_live_stream: true,
      // id: line이 없어도 RN EventSource lastEventId는 marker 80을 유지한다.
      }, '80');
    });

    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(1);
    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('80');
    const rendered = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(rendered).toHaveLength(1);
    expect(rendered[0].event.data.content).toBe('durable final');
  });

  test('history_sync 비동기 drain 중에도 marker 뒤 carried-cursor live를 snapshot 다음에 적용한다', async () => {
    jest.useFakeTimers();
    try {
      await renderSettled();
      const sse = latestSseOptions();
      const streamIdentity = 'codex_app_server:stream-drain';

      act(() => {
        sse.onOpen?.();
        for (let id = 1; id <= 51; id += 1) {
          sse.onEvent('system', { message: `replay-${id}` }, String(id));
        }
        sse.onEvent('text_snapshot', {
          type: 'text_snapshot',
          basedOnEventId: 1003,
          throughLiveSeq: 41,
          streams: [{
            streamIdentity,
            text: 'prefix',
            updatedAt: '2026-08-06T00:00:05.000Z',
            truncated: false,
            resetRequired: false,
            recovery: 'none',
          }],
        }, '');
        sse.onEvent('history_sync', {
          type: 'history_sync',
          last_event_id: 1003,
          is_live: true,
          reset_required: false,
        }, '');
        // id: line이 없는 marker 뒤 live frame도 RN EventSource는 cursor 1003을 유지한다.
        sse.onEvent('text_delta', {
          type: 'text_delta',
          text: '+live',
          raw_event_type: 'item/agentMessage/delta',
          item_id: 'item-after-marker',
          streamIdentity,
          liveSeq: 42,
          liveTextMode: 'append',
          _live_only: true,
        }, '1003');
      });

      expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(50);
      expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();

      act(() => { jest.runOnlyPendingTimers(); });
      expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(51);
      expect(useChatStore.getState().streamingSlotsBySession[SID]
        ?.assistantByStream?.[streamIdentity]?.data.text).toBe('prefix+live');
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('1003');
    } finally {
      jest.useRealTimers();
    }
  });

  test('동일 append chunk 두 건이 catchup 50/51 경계에서도 서로 다른 durable id로 보존된다', async () => {
    jest.useFakeTimers();
    try {
      await renderSettled();
      const sse = latestSseOptions();
      act(() => {
        sse.onOpen?.();
        for (let id = 1; id <= 49; id += 1) {
          sse.onEvent('system', { message: `replay-${id}` }, String(id));
        }
        const identicalAppend = {
          type: 'text_delta',
          text: 'x',
          _live_only: true,
          tool_use_id: 'item-identical-append',
          raw_event_type: 'item/agentMessage/delta',
        };
        sse.onEvent('text_delta', identicalAppend, '50');
        sse.onEvent('text_delta', identicalAppend, '51');
        sse.onEvent('history_sync', {
          type: 'history_sync',
          last_event_id: 51,
          is_live: true,
          reset_required: false,
        }, '');
      });
      act(() => { jest.runOnlyPendingTimers(); });

      const textEvents = useChatStore.getState().eventsBySession[SID]
        ?.filter((event) => event.type === 'text_delta');
      expect(textEvents?.map((event) => event.id)).toEqual(['50', '51']);
      const rendered = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
      const textItem = rendered.find((item: any) => item.event?.data?.text === 'xx');
      expect(textItem).toBeDefined();
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('51');
    } finally {
      jest.useRealTimers();
    }
  });

  test('두 번째 catchup chunk commit 실패는 committed cursor에서 상세 SSE를 재시작한다', async () => {
    jest.useFakeTimers();
    try {
      let commitCount = 0;
      useChatStore.setState({
        mergeEvents: (sessionId, events) => {
          commitCount += 1;
          if (commitCount === 2) throw new Error('second chunk failed');
          originalMergeEvents(sessionId, events);
        },
      });
      await renderSettled();
      const sse = latestSseOptions();
      const failConnection = jest.fn();
      if (!sse.consumerFailureRef) throw new Error('consumerFailureRef missing');
      sse.consumerFailureRef.current = failConnection;
      act(() => {
        sse.onOpen?.();
        for (let id = 1; id <= 51; id += 1) {
          sse.onEvent('system', { message: `replay-${id}` }, String(id));
        }
        sse.onEvent('history_sync', {
          type: 'history_sync',
          last_event_id: 60,
          is_live: true,
          reset_required: false,
        }, '');
      });

      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');
      act(() => { jest.runOnlyPendingTimers(); });

      expect(failConnection).toHaveBeenCalledWith(expect.objectContaining({
        message: 'second chunk failed',
      }));
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');
    } finally {
      jest.useRealTimers();
    }
  });

  test('thinking timer commit 실패도 cursor를 넘기지 않고 상세 SSE를 재시작한다', async () => {
    jest.useFakeTimers();
    try {
      useChatStore.setState({
        setStreamingEvent: () => { throw new Error('thinking commit failed'); },
      });
      await renderSettled();
      const sse = latestSseOptions();
      const failConnection = jest.fn();
      if (!sse.consumerFailureRef) throw new Error('consumerFailureRef missing');
      sse.consumerFailureRef.current = failConnection;
      act(() => {
        sse.onOpen?.();
        sse.onEvent('history_sync', {
          type: 'history_sync',
          last_event_id: 20,
          is_live: true,
          reset_required: false,
        }, '');
        sse.onEvent('thinking_delta', {
          type: 'thinking_delta',
          thinking: 'must replay',
          _live_only: true,
        }, '21');
      });

      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('20');
      act(() => { jest.runOnlyPendingTimers(); });

      expect(failConnection).toHaveBeenCalledWith(expect.objectContaining({
        message: 'thinking commit failed',
      }));
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('20');
    } finally {
      jest.useRealTimers();
    }
  });

  test('history finally commit 실패도 같은 상세 SSE failure bridge를 사용한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const failConnection = jest.fn();
    if (!sse.consumerFailureRef) throw new Error('consumerFailureRef missing');
    sse.consumerFailureRef.current = failConnection;
    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    const error = new Error('history queue commit failed');

    act(() => {
      historyOptions.onAsyncCommitError(error);
    });

    expect(failConnection).toHaveBeenCalledWith(error);
  });

  test('text snapshot drain 도중 active=false면 미커밋 snapshot/live/cursor를 모두 버린다', async () => {
    jest.useFakeTimers();
    try {
      const view = await renderSettled();
      const sse = latestSseOptions();
      const streamIdentity = 'codex_app_server:inactive-race';
      act(() => {
        sse.onOpen?.();
        for (let id = 1; id <= 51; id += 1) {
          sse.onEvent('system', { message: `replay-${id}` }, String(id));
        }
        sse.onEvent('text_snapshot', {
          type: 'text_snapshot',
          basedOnEventId: 1003,
          throughLiveSeq: 41,
          streams: [{
            streamIdentity,
            text: 'uncommitted prefix',
            updatedAt: '2026-08-06T00:00:05.000Z',
            truncated: false,
            resetRequired: false,
            recovery: 'none',
          }],
        }, '');
        sse.onEvent('history_sync', {
          type: 'history_sync',
          last_event_id: 1003,
          is_live: true,
          reset_required: false,
        }, '');
        sse.onEvent('text_delta', {
          type: 'text_delta',
          text: '+uncommitted live',
          streamIdentity,
          liveSeq: 42,
          liveTextMode: 'append',
        }, '');
      });
      act(() => {
        view.rerender(
          <View><ChatBody sessionId={SID} active={false} /></View>,
        );
      });
      act(() => { jest.runOnlyPendingTimers(); });

      expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(50);
      expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');
      expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('truncated/resetRequired snapshot은 partial을 숨기고 일치하는 durable final만 복구한다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const streamIdentity = 'codex_sdk:aXRlbS1iaWc';

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 1003,
        throughLiveSeq: 99,
        streams: [{
          streamIdentity,
          text: null,
          updatedAt: '2026-08-06T00:00:06.000Z',
          truncated: true,
          resetRequired: true,
          recovery: 'durable_final',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 1003,
        is_live: true,
        reset_required: false,
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: 'must stay hidden',
        streamIdentity,
        liveSeq: 100,
        liveTextMode: 'replace',
      }, '');
    });
    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantByStream).toBeUndefined();
    const hiddenItems = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(hiddenItems).toHaveLength(0);

    act(() => {
      sse.onEvent('assistant_message', {
        type: 'assistant_message',
        content: 'durable final',
        _final_for_live_stream: true,
        streamIdentity,
        liveSeq: 101,
        liveTextMode: 'replace',
      }, '1004');
    });

    expect(useChatStore.getState().eventsBySession[SID]).toEqual([{
      id: '1004',
      type: 'assistant_message',
      data: expect.objectContaining({ content: 'durable final', streamIdentity }),
    }]);
    expect(useChatStore.getState().streamingSlotsBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('1004');
  });

  test('capped snapshot A가 남아 있어도 새 stream B의 text_end와 final은 숨기지 않는다', async () => {
    await renderSettled();
    const sse = latestSseOptions();
    const cappedIdentity = 'codex_sdk:Y2FwcGVkLWE';
    const nextIdentity = 'codex_app_server:dGhyZWFkOnR1cm46aXRlbS1i';

    act(() => {
      sse.onOpen?.();
      sse.onEvent('text_snapshot', {
        type: 'text_snapshot',
        basedOnEventId: 1100,
        throughLiveSeq: 20,
        streams: [{
          streamIdentity: cappedIdentity,
          text: null,
          updatedAt: '2026-08-06T00:00:06.000Z',
          truncated: true,
          resetRequired: true,
          recovery: 'durable_final',
        }],
      }, '');
      sse.onEvent('history_sync', {
        type: 'history_sync',
        last_event_id: 1100,
        is_live: true,
        reset_required: false,
      }, '');
      sse.onEvent('text_delta', {
        type: 'text_delta',
        text: 'stream B partial',
        _live_only: true,
        tool_use_id: 'item-b',
        streamIdentity: nextIdentity,
        liveSeq: 21,
        liveTextMode: 'append',
      }, '1101');
      sse.onEvent('text_end', {
        type: 'text_end',
        _live_only: true,
        tool_use_id: 'item-b',
        streamIdentity: nextIdentity,
        liveSeq: 22,
        liveTextMode: 'append',
      }, '1102');
    });

    const endedItems = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(endedItems).toHaveLength(1);
    expect(endedItems[0].event.data.text).toBe('stream B partial');
    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantSnapshotStreams).toEqual({ [cappedIdentity]: true });

    act(() => {
      sse.onEvent('assistant_message', {
        type: 'assistant_message',
        content: 'stream B final',
        _event_id: 1103,
        _final_for_live_stream: true,
        tool_use_id: 'item-b',
        streamIdentity: nextIdentity,
        liveSeq: 23,
        liveTextMode: 'append',
      }, '1103');
    });

    const finalItems = mockRenderChatEventList.mock.calls.at(-1)?.[0].items;
    expect(finalItems).toHaveLength(1);
    expect(finalItems[0].event.data.content).toBe('stream B final');
    expect(useChatStore.getState().streamingSlotsBySession[SID]
      ?.assistantSnapshotStreams).toEqual({ [cappedIdentity]: true });
  });

  test('reset_required history_sync는 캐시를 비우고 같은 세션의 스냅샷 로드를 다시 발화한다', async () => {
    useChatStore.getState().mergeEvents(SID, [
      { id: '100', type: 'assistant_message', data: { content: 'cached' } },
    ]);
    useChatStore.getState().setLastEventId(SID, '100');
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent(
        'history_sync',
        { is_live: true, last_event_id: 250, reset_required: true },
        '',
      );
    });

    let state = useChatStore.getState();
    expect(state.eventsBySession[SID]).toBeUndefined();
    expect(state.streamingSlotsBySession[SID]).toBeUndefined();
    expect(state.lastEventIdBySession[SID]).toBeUndefined();
    expect(mockHistoryLoadingRef.current).toBe(true);
    const historyOptions = mockUseChatHistoryPagination.mock.calls.at(-1)?.[0] as any;
    expect(historyOptions).toEqual(
      expect.objectContaining({ snapshotGeneration: 1 }),
    );

    act(() => {
      historyOptions.onInitialPageCommitted(SID);
    });
    state = useChatStore.getState();
    expect(state.lastEventIdBySession[SID]).toBe('250');
  });

  test('result 이벤트는 /api/sessions/stream 갱신 없이 세션 status를 바꾸지 않는다', async () => {
    useSessionStore.getState().upsertSession({
      agentSessionId: SID, nodeId: 'node-1', displayName: 'Test session', status: 'running',
      createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
    });
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 300 }, '');
      sse.onEvent('result', { output: 'done' }, '301');
    });

    expect(useSessionStore.getState().sessions[SID].status).toBe('running');
  });

  test('session_ended는 더 새로운 종료 상태와 종료 메타를 세션에 조정한다', async () => {
    useSessionStore.getState().upsertSession({
      agentSessionId: SID, nodeId: 'node-1', displayName: 'Test session',
      status: 'running',
      createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
      lastEventId: 300,
    });
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 300 }, '');
      sse.onEvent('session_ended', {
        status: 'completed',
        termination_reason: 'completed_ok',
        termination_detail: 'turn finished',
        _event_id: 301,
      }, '301');
    });

    expect(useSessionStore.getState().sessions[SID]).toMatchObject({
      status: 'completed',
      terminationReason: 'completed_ok',
      terminationDetail: 'turn finished',
      lastEventId: 301,
    });
  });

  test('payload _event_id가 없는 session_ended replay도 SSE id로 상태와 생각 중 표시를 조정한다', async () => {
    useSessionStore.getState().upsertSession({
      agentSessionId: SID,
      nodeId: 'node-1',
      displayName: 'Test session',
      status: 'running',
      createdAt: '2026-05-23T00:00:00Z',
      updatedAt: '2026-05-23T00:00:00Z',
      lastEventId: 300,
    });
    const view = render(<View><ChatBody sessionId={SID} /></View>);
    await act(async () => {
      await Promise.resolve();
    });
    const visibleItems = () => mockRenderChatEventList.mock.calls.at(-1)?.[0].items ?? [];
    expect(visibleItems()).toContainEqual(expect.objectContaining({ kind: 'typing' }));
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 300 }, '');
      sse.onEvent('session_ended', {
        status: 'completed',
        termination_reason: 'completed_ok',
        termination_detail: null,
      }, '301');
    });

    expect(useSessionStore.getState().sessions[SID]).toMatchObject({
      status: 'completed',
      terminationReason: 'completed_ok',
      terminationDetail: null,
      lastEventId: 301,
    });
    expect(visibleItems()).not.toContainEqual(expect.objectContaining({ kind: 'typing' }));
    view.unmount();
  });

  test('session_ended 뒤 더 새로운 session_updated running 신호가 다시 이긴다', async () => {
    useSessionStore.getState().upsertSession({
      agentSessionId: SID, nodeId: 'node-1', displayName: 'Test session',
      status: 'running',
      createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
      lastEventId: 400,
    });
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 400 }, '');
      sse.onEvent('session_ended', {
        status: 'completed',
        termination_reason: 'completed_ok',
        termination_detail: null,
        _event_id: 401,
      }, '401');
    });
    expect(useSessionStore.getState().sessions[SID].status).toBe('completed');

    act(() => {
      useSessionStore.getState().updateSession(SID, {
        status: 'running',
        terminationReason: 'running_transition',
        terminationDetail: null,
        lastEventId: 402,
      });
    });

    expect(useSessionStore.getState().sessions[SID]).toMatchObject({
      status: 'running',
      terminationReason: 'running_transition',
      lastEventId: 402,
    });
  });

  test('낡은 session_ended는 더 새로운 running 상태를 덮어쓰지 않는다', async () => {
    useSessionStore.getState().upsertSession({
      agentSessionId: SID, nodeId: 'node-1', displayName: 'Test session',
      status: 'running',
      terminationReason: 'running_transition',
      createdAt: '2026-05-23T00:00:00Z', updatedAt: '2026-05-23T00:00:00Z',
      lastEventId: 502,
    });
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 502 }, '');
      sse.onEvent('session_ended', {
        status: 'completed',
        termination_reason: 'completed_ok',
        termination_detail: 'stale completion',
        _event_id: 501,
      }, '501');
    });

    expect(useSessionStore.getState().sessions[SID]).toMatchObject({
      status: 'running',
      terminationReason: 'running_transition',
      lastEventId: 502,
    });
  });

  test('새 user_message 이벤트도 /api/sessions/stream 갱신 없이 lifecycle을 바꾸지 않는다', async () => {
    useSessionStore.getState().updateSession(SID, { status: 'completed' });
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 400 }, '');
      sse.onEvent('user_message', { text: 'again' }, '401');
    });

    expect(useSessionStore.getState().sessions[SID].status).toBe('completed');
  });

  test('live-only text_delta 경로도 chat tree만 갱신한다', async () => {
    useSessionStore.getState().updateSession(SID, { status: 'completed' });
    await renderSettled();
    const sse = latestSseOptions();

    act(() => {
      sse.onOpen?.();
      sse.onEvent('history_sync', { is_live: true, last_event_id: 500 }, '');
      sse.onEvent(
        'text_delta',
        {
          text: 'live',
          item_id: 'item-live-status',
          raw_event_type: 'item/agentMessage/delta',
          _live_only: true,
        },
        '500',
      );
    });

    expect(useSessionStore.getState().sessions[SID].status).toBe('completed');
    expect(
      useChatStore.getState().streamingSlotsBySession[SID]?.assistant?.data.text,
    ).toBe('live');
  });

  test('현재 열린 running session은 offline 전환에도 유지되고 입력만 차단했다가 reconnect 즉시 복구한다', async () => {
    useSessionStore.getState().updateSession(SID, { status: 'running' });
    act(() => {
      useNodeConnectivityStore.getState().applySnapshot([{ nodeId: 'node-2' }]);
    });

    const view = await renderSettled();

    expect(view.getByTestId('chat-event-list')).toBeTruthy();
    expect(view.getByTestId('chat-composer').props.accessibilityState.disabled).toBe(true);
    expect(view.getByTestId('chat-offline-input-notice')).toBeTruthy();
    expect(mockUseChatAttachments.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    expect(mockUseChatSendFlow.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ disabled: true }),
    );

    act(() => {
      useNodeConnectivityStore.getState().upsert({ nodeId: 'node-1' });
    });

    expect(view.getByTestId('chat-composer').props.accessibilityState.disabled).toBe(false);
    expect(view.queryByTestId('chat-offline-input-notice')).toBeNull();
  });

  test('알 수 없는 전송 결과 뒤 같은 ChatBody를 다시 열어도 보낸 글은 입력창에 돌아오지 않는다', async () => {
    await preparePersistentChatDrafts();

    let resolveIntervene!: (value: { delivered: null; outcome: 'unknown' }) => void;
    const request = new Promise<{ delivered: null; outcome: 'unknown' }>((resolve) => {
      resolveIntervene = resolve;
    });
    mockApiClient.intervene.mockReturnValue(request);
    mockUseChatSendFlow.mockImplementation(((options: any) => realUseChatSendFlow(options)) as any);

    const message = '유휴 세션으로 보낸 원문';
    const view = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(view.getByTestId('chat-composer-input'), message);
    expect(useDraftStore.getState().drafts[persistentChatDraftKey(SID)]).toBe(message);
    fireEvent.press(view.getByTestId('chat-send-button'));

    expect(mockApiClient.intervene).toHaveBeenCalledWith(SID, message, undefined);
    expect(view.getByTestId('chat-composer-input').props.value).toBe('');
    expect(useDraftStore.getState().drafts[persistentChatDraftKey(SID)]).toBeUndefined();

    await act(async () => {
      resolveIntervene({ delivered: null, outcome: 'unknown' });
      await mockSendPromise;
    });
    view.unmount();

    const reopened = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(reopened.getByTestId('chat-composer-input').props.value).toBe('');
    reopened.unmount();
  });

  test('오버레이 담당 세션에 보낸 메시지는 PAS 전역 선택을 바꾸지 않고 담당 ID로 전달한다', async () => {
    await preparePersistentChatDrafts();
    const assignedSessionId = 'assigned-overlay-session';
    useSessionStore.setState(state => ({ sessions: {
      ...state.sessions,
      [assignedSessionId]: {
        agentSessionId: assignedSessionId,
        nodeId: 'node-1',
        displayName: '담당 세션',
        status: 'idle',
        createdAt: '2026-05-23T00:00:00Z',
        updatedAt: '2026-05-23T00:00:00Z',
      },
    } }));
    useUIStore.setState({ activeSessionId: 'pas-background-session' });
    mockApiClient.intervene.mockResolvedValue({ delivered: true, outcome: 'delivered' });
    mockUseChatSendFlow.mockImplementation(((options: any) => realUseChatSendFlow(options)) as any);

    const view = render(<ChatBody sessionId={assignedSessionId} />);
    await act(async () => { await Promise.resolve(); });
    const message = '담당 세션에 전달할 내용';
    fireEvent.changeText(view.getByTestId('chat-composer-input'), message);
    await act(async () => { fireEvent.press(view.getByTestId('chat-send-button')); });

    expect(mockApiClient.intervene).toHaveBeenCalledWith(assignedSessionId, message, undefined);
    expect(useUIStore.getState().activeSessionId).toBe('pas-background-session');
    view.unmount();
  });

  test('실패 말풍선의 되돌리기는 원문을 입력창과 영속 초안에 복원한다', async () => {
    await preparePersistentChatDrafts();
    mockApiClient.intervene.mockResolvedValue({ delivered: null, outcome: 'unknown' });
    mockUseChatSendFlow.mockImplementation(((options: any) => realUseChatSendFlow(options)) as any);

    const message = '되돌릴 실패 원문';
    const view = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.changeText(view.getByTestId('chat-composer-input'), message);
    fireEvent.press(view.getByTestId('chat-send-button'));
    await act(async () => {
      await mockSendPromise;
    });

    const pending = useChatStore.getState().pendingOptimisticBySession[SID];
    expect(pending?.pendingStatus).toBe('failed');
    mockRestorePendingEventId = pending?.id;
    fireEvent.press(view.getByTestId('chat-event-list-restore-pending'));

    expect(view.getByTestId('chat-composer-input').props.value).toBe(message);
    expect(useDraftStore.getState().drafts[persistentChatDraftKey(SID)]).toBe(message);
    view.unmount();

    const reopened = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(reopened.getByTestId('chat-composer-input').props.value).toBe(message);
    reopened.unmount();
  });

  test('보내지 않은 세션 초안은 재마운트와 세션 전환 뒤에도 각 세션에 남는다', async () => {
    await preparePersistentChatDrafts();
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [OTHER_SID]: {
          agentSessionId: OTHER_SID,
          nodeId: 'node-1',
          displayName: 'Other session',
          status: 'idle',
          createdAt: '2026-05-23T00:00:00Z',
          updatedAt: '2026-05-23T00:00:00Z',
        },
      },
    }));

    const view = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.changeText(view.getByTestId('chat-composer-input'), '세션 A 초안');
    view.unmount();

    const reopened = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(reopened.getByTestId('chat-composer-input').props.value).toBe('세션 A 초안');
    reopened.rerender(
      <View>
        <ChatBody sessionId={OTHER_SID} />
      </View>,
    );
    expect(reopened.getByTestId('chat-composer-input').props.value).toBe('');
    fireEvent.changeText(reopened.getByTestId('chat-composer-input'), '세션 B 초안');
    reopened.rerender(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    expect(reopened.getByTestId('chat-composer-input').props.value).toBe('세션 A 초안');
    reopened.rerender(
      <View>
        <ChatBody sessionId={OTHER_SID} />
      </View>,
    );
    expect(reopened.getByTestId('chat-composer-input').props.value).toBe('세션 B 초안');
    reopened.unmount();
  });

  test('session change resets the composer stack latch for the next short draft', async () => {
    await preparePersistentChatDrafts();
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [OTHER_SID]: {
          agentSessionId: OTHER_SID,
          nodeId: 'node-1',
          displayName: 'Other session',
          status: 'idle',
          createdAt: '2026-05-23T00:00:00Z',
          updatedAt: '2026-05-23T00:00:00Z',
        },
      },
    }));
    useDraftStore.getState().write(persistentChatDraftKey(OTHER_SID), '세션 B 짧은 초안');

    const view = render(
      <View>
        <ChatBody sessionId={SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.changeText(view.getByTestId('chat-composer-input'), '세션 A 첫 줄\n둘째 줄');
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByTestId('chat-composer-content-row').props.style.flexWrap).toBe('wrap');

    view.rerender(
      <View>
        <ChatBody sessionId={OTHER_SID} />
      </View>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByTestId('chat-composer-input').props.value).toBe('세션 B 짧은 초안');
    expect(view.getByTestId('chat-composer-content-row').props.style.flexWrap).toBe('nowrap');
    view.unmount();
  });
});
