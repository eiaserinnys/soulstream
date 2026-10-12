import React from 'react';
import { ActionSheetIOS, TextInput } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { ChatBody } from '../ChatBody';
import { useChatStore } from '../../../store/chatStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useAuthStore } from '../../../store/authStore';
import { useDraftStore } from '../../../store/draftStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';
import { useSSEStream } from '../../../hooks/useSSEStream';
import { chatUiFixtureEvent } from '../../../component-review/chat-ui-fixtures';
import { groupChatEvents, projectManuscriptMessages } from '../groupChatEvents';
import { projectCacheKeepaliveTurns } from '../cacheKeepaliveProjection';
import type { SessionEvent } from '../../../api/types';

// Existing ChatBody/AssistantMessage test patterns: replace OS transport and
// native markdown/slider only. History, SSE gate, store, list and draft are real.
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react'); const { Text, TextInput } = require('react-native');
  return {
    EnrichedMarkdownText: (props: any) => React.createElement(Text, { testID: 'assistant-markdown' }, props.markdown),
    EnrichedMarkdownTextInput: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ focus() {}, setSelection() {} }));
      return React.createElement(TextInput, props);
    }),
  };
});
jest.mock('@react-native-community/slider', () => {
  const React = require('react'); return (props: any) => React.createElement(require('react-native').View, props);
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('../../../hooks/useSSEStream', () => ({
  ...jest.requireActual('../../../hooks/useSSEStream'), useSSEStream: jest.fn(),
}));
const mockApi = {
  sessionEventsUrl: jest.fn(() => 'https://public.test/events'),
  getTimeline: jest.fn(),
  getSessionsByIds: jest.fn().mockResolvedValue([]),
  getPersistentSession: jest.fn().mockResolvedValue({ session: { persistent: false, settings: {} } }),
  getQueue: jest.fn().mockResolvedValue({ messages: [] }),
  intervene: jest.fn(),
};
jest.mock('../../../api/client', () => ({ createApiClient: () => mockApi }));
jest.mock('../SessionStoryPanel', () => ({ SessionStoryPanel: () => null }));
jest.mock('../ChatRuntimeStrips', () => ({ ChatRuntimeStrips: () => null }));
jest.mock('../RealtimeVoiceControls', () => ({ RealtimeVoiceControls: () => null }));
const ui = { ...chatUiFixtureEvent('normal'), id: '2' };
const stored = { id: 2, event_type: ui.type, payload: ui.data, parent_event_id: 1, created_at: '2026-10-12T00:00:01Z' };
const session = (id: string) => ({ agentSessionId: id, nodeId: 'public-node', status: 'completed' as const,
  displayName: '공개 예시', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' });
beforeEach(async () => {
  jest.clearAllMocks();
  await useAuthStore.persist.rehydrate(); await useSettingsStore.persist.rehydrate(); await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: `header.${Buffer.from(JSON.stringify({ email: 'public@example.invalid', sub: 'public', exp: 9999999999 })).toString('base64url')}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://public.test', serverType: 'soul-server', nodeId: 'public-node' });
  useNodeConnectivityStore.getState().reset();
  useDraftStore.setState({ drafts: {} });
  useChatStore.setState({ eventsBySession: {}, lastEventIdBySession: {}, streamingSlotsBySession: {}, pendingOptimisticBySession: {}, pendingFirstMessageBySession: {} });
  useSessionStore.setState({ sessions: { one: session('one'), two: session('two') } });
  mockApi.getTimeline.mockResolvedValue({ messages: [stored], next_cursor: null });
});
async function open(presentation: 'default' | 'manuscript' = 'default') {
  const screen = render(<ChatBody sessionId="one" presentation={presentation} showSessionAuxiliary={false} />);
  await waitFor(() => expect(screen.getByLabelText('인원수')).toBeTruthy());
  return screen;
}
async function sse(type: string, data: Record<string, unknown>, id?: string) {
  const callback = jest.mocked(useSSEStream).mock.calls.at(-1)![0].onEvent;
  await act(async () => callback(type, { ...data, session_id: 'one', ...(id ? { _event_id: Number(id) } : {}) }, id ?? ''));
}
function edit(screen: Awaited<ReturnType<typeof open>>) {
  fireEvent.changeText(screen.getByLabelText('인원수'), '12');
  fireEvent.press(screen.getByLabelText('연간 결제 (20% 할인)'));
  expect(screen.getByText('278,400원/월')).toBeTruthy();
}
test.each(['default', 'manuscript'] as const)('real %s body appends into the draft, undo and notice stay at the composer', async presentation => {
  const screen = await open(presentation); edit(screen);
  const input = () => screen.getByTestId('chat-composer-text-input');
  expect(input()).toBeTruthy();
  fireEvent.changeText(input(), '쓰던 글');
  fireEvent.press(screen.getByLabelText('이 조건으로 질문'));
  expect(input().props.value).toMatch(/^쓰던 글\n\n.*12/);
  expect(mockApi.intervene).not.toHaveBeenCalled();
  expect(Object.values(useDraftStore.getState().drafts)).toContain(input().props.value);
  expect(screen.queryByTestId('chat-ui-action-notice')).toBeNull();
  fireEvent.press(screen.getByLabelText('되돌리기')); expect(input().props.value).toBe('쓰던 글');
  fireEvent.press(screen.getByLabelText('이 조건으로 질문'));
  fireEvent.changeText(input(), input().props.value + ' 직접 수정');
  expect(screen.queryByLabelText('되돌리기')).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('복사')));
  expect(screen.getByTestId('chat-composer-generated-row').findByProps({ testID: 'chat-ui-action-notice' })).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('인원수'), '13');
  expect(screen.queryByTestId('chat-ui-action-notice')).toBeNull();
});
test('same id SSE/history is one row, row remount retains state, changing session resets defaults', async () => {
  const screen = await open(); edit(screen);
  await sse(ui.type, ui.data, ui.id); await sse('history_sync', { last_event_id: 2 });
  expect(screen.getAllByLabelText('인원수')).toHaveLength(1);
  act(() => useChatStore.setState({ eventsBySession: { one: [] } }));
  act(() => useChatStore.getState().mergeEvents('one', [ui]));
  expect(screen.getByLabelText('인원수').props.value).toBe('12');
  screen.rerender(<ChatBody sessionId="two" showSessionAuxiliary={false} />);
  await waitFor(() => expect(screen.getByLabelText('인원수').props.value).toBe('8'));
});
test('menu copies and selects current values, then returns to the same interactive values', async () => {
  const screen = await open(); edit(screen);
  const show = jest.fn(); (ActionSheetIOS as any).showActionSheetWithOptions = show;
  fireEvent(screen.getByTestId('event-context-menu-anchor'), 'longPress');
  const choose = show.mock.calls[0][1];
  await act(async () => choose(0));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(expect.stringContaining('278,400원'));
  act(() => choose(1));
  expect(screen.getByTestId('message-selection-view')).toBeTruthy();
  expect(screen.queryByLabelText('인원수')).toBeNull();
  fireEvent.press(screen.getByTestId('message-selection-done'));
  expect(screen.getByLabelText('인원수').props.value).toBe('12');
});
test('ordinary live answer → UI → ordinary final keeps both responses', async () => {
  mockApi.getTimeline.mockResolvedValue({ messages: [], next_cursor: null });
  const screen = render(<ChatBody sessionId="one" showSessionAuxiliary={false} />);
  await act(async () => { await Promise.resolve(); });
  await sse('history_sync', { last_event_id: 0 });
  await sse('text_delta', { text: '진행 중 일반 답' });
  await sse(ui.type, ui.data, '2');
  await sse('assistant_message', { content: '일반 최종', final: true }, '3');
  expect(screen.getByLabelText('인원수')).toBeTruthy();
  expect(screen.getByText('일반 최종')).toBeTruthy();
});
test('text_start/delta interrupted by UI keeps separate text runs', async () => {
  const screen = await open();
  const events: SessionEvent[] = [
    { id: '1', type: 'text_start', data: {} }, { id: '2', type: 'text_delta', data: { text: '앞 글' } },
    { ...ui, id: '3' }, { id: '4', type: 'text_delta', data: { text: '뒤 글' } }, { id: '5', type: 'text_end', data: {} },
  ];
  act(() => useChatStore.setState({ eventsBySession: { one: events } }));
  expect(screen.getByText('앞 글')).toBeTruthy(); expect(screen.getByText('뒤 글')).toBeTruthy();
  expect(screen.getAllByLabelText('인원수')).toHaveLength(1);
});
test('PAS tool/thinking activity breaks at UI and preserves delegation/notification/keepalive hiding', async () => {
  const screen = await open('manuscript');
  const events: SessionEvent[] = [
    { id: '1', type: 'thinking_start', data: {} }, { id: '2', type: 'thinking_delta', data: { text: '생각' } },
    { ...ui, id: '3' }, { id: '4', type: 'tool_start', data: { tool_name: 'Read', tool_use_id: 'read' } },
    { id: '5', type: 'user_message', data: { text: '위임 보고', caller_info: { source: 'agent' } } },
    { id: '6', type: 'session_notification', data: { text: '자동 알림', delivery_intent: 'completion_notification', disposition: 'queued' } },
    { id: '7', type: 'user_message', data: { text: 'keepalive', purpose: 'cache_keepalive' } },
    { id: '8', type: 'assistant_message', data: { content: 'keepalive 답' } },
  ];
  const projection = projectManuscriptMessages(groupChatEvents(projectCacheKeepaliveTurns(events).displayEvents));
  const ids = projection.filter(item => item.kind === 'event').map(item => item.event.id);
  expect(ids).not.toEqual(expect.arrayContaining(['5', '6', '7', '8']));
  expect(ids).toContain('3');
  act(() => useChatStore.setState({ eventsBySession: { one: events } }));
  expect(screen.getByLabelText('인원수')).toBeTruthy();
  expect(screen.queryByText('위임 보고')).toBeNull(); expect(screen.queryByText('자동 알림')).toBeNull();
});
