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
const mockListMount = jest.fn();
const mockListUnmount = jest.fn();
// Keep the real list; the probe measures its lifecycle beneath ChatBody.
jest.mock('../ChatEventList', () => {
  const React = require('react');
  const { ChatEventList } = jest.requireActual('../ChatEventList');
  return { ChatEventList: React.memo((props: any) => {
    React.useEffect(() => { mockListMount(); return () => mockListUnmount(); }, []);
    return React.createElement(ChatEventList, props);
  }) };
});
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
  mockApi.getTimeline.mockResolvedValue({ messages: [], next_cursor: null });
  jest.useFakeTimers();
});
afterEach(async () => {
  await act(async () => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
});

const report = { key: 'ask-one', kind: 'ask', title: '예산 확인', card_numbers: [270], context: '팀 예산을 확인해 주세요.', action: '어떻게 진행할까요?', options: ['응', '보류'], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z' };
async function openReport() {
  useSessionStore.setState({ persistentReportsBySession: { one: { entries: [report] } } } as any);
  const screen = render(<ChatBody sessionId="one" presentation="manuscript" showSessionAuxiliary={false} {...({ showPersistentReport: true } as any)} />);
  await waitFor(() => expect(screen.getByTestId('report-track')).toBeTruthy());
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 200 } } });
  return screen;
}
test('report answer appends into the actual composer with undo and sending/failed/server state', async () => {
  const screen = await openReport();
  const input = () => screen.getByTestId('chat-composer-text-input');
  fireEvent.changeText(input(), '쓰던 글');
  fireEvent.press(screen.getByLabelText('응'));
  expect(input().props.value).toBe('쓰던 글\n\n예산 확인: 응');
  fireEvent.press(screen.getByLabelText('되돌리기'));
  expect(input().props.value).toBe('쓰던 글');
  fireEvent.press(screen.getByLabelText('응'));
  let reject!: (error: Error) => void;
  mockApi.intervene.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.press(screen.getByTestId('chat-composer-send-button'));
  await waitFor(() => expect(screen.getByText('답 받음')).toBeTruthy());
  expect(mockApi.intervene).toHaveBeenCalledWith('one', '쓰던 글\n\n예산 확인: 응', undefined, [{ key: 'persistent_report_reply', content: { key: 'ask-one', option: '응' } }]);
  await act(async () => reject(Error('failed')));
  expect(screen.getByText('답하실 것')).toBeTruthy();
  mockApi.intervene.mockResolvedValueOnce({ delivered: true });
  const pending = useChatStore.getState().pendingOptimisticBySession.one;
  await act(async () => fireEvent.press(screen.getByLabelText('다시 보내기')));
  expect(mockApi.intervene.mock.calls.at(-1)![3]).toEqual(pending.contextItems);
  expect(screen.getByText('답 받음')).toBeTruthy();
  act(() => useSessionStore.getState().applyPersistentReport('one', [{ ...report, kind: 'ask', state: 'open', title: '새 예산 확인' }]));
  expect(screen.getByText('답하실 것')).toBeTruthy();
  expect(screen.getByText('새 예산 확인')).toBeTruthy();
  expect(mockListMount).toHaveBeenCalledTimes(1);
  expect(mockListUnmount).not.toHaveBeenCalled();
});
test('editing the appended answer sends visible context without changing the report', async () => {
  const screen = await openReport();
  const input = screen.getByTestId('chat-composer-text-input');
  fireEvent.press(screen.getByLabelText('응'));
  fireEvent.changeText(input, '예산 확인: 다른 의견');
  mockApi.intervene.mockResolvedValueOnce({ delivered: true });
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-send-button')));
  expect(mockApi.intervene).toHaveBeenCalledWith('one', '예산 확인: 다른 의견', undefined, [{ key: 'persistent_report_visible', content: { key: 'ask-one', title: '예산 확인' } }]);
  expect(screen.getByText('답하실 것')).toBeTruthy();
});
