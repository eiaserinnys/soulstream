import React from 'react';
import { ActionSheetIOS, TextInput } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { ChatBody } from '../ChatBody';
import { useChatStore, createOptimisticUserEvent } from '../../../store/chatStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useAuthStore } from '../../../store/authStore';
import { useDraftStore } from '../../../store/draftStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';
import { useSSEStream } from '../../../hooks/useSSEStream';
import { chatUiFixtureEvent } from '../../../component-review/chat-ui-fixtures';
import { groupChatEvents, projectManuscriptMessages } from '../groupChatEvents';
import { projectCacheKeepaliveTurns } from '../cacheKeepaliveProjection';
import type { PersistentReportEntry, SessionEvent } from '../../../api/types';
import { ChatUiControllerProvider, useChatUiActions } from '../../chat-ui/ChatUiControllerProvider';
import { usePersistentReport } from '../../persistent/usePersistentReport';
import { usePersistentReportSend, FAILED_REPORT_SEND_REMAINS } from '../../persistent/usePersistentReportSend';
import { PersistentReportPager } from '../../persistent/PersistentReportPager';
import type { ChatInputComposerHandle } from '../ChatInputComposer';

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
  dismissPersistentReport: jest.fn(),
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

const report: PersistentReportEntry = { key: 'ask-one', kind: 'ask', title: '예산 확인', card_numbers: [270], context: '팀 예산을 확인해 주세요.', action: '어떻게 진행할까요?', options: ['응', '보류'], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z' };
function ReportHost() {
  const ref = React.useRef<ChatInputComposerHandle>(null);
  return <ChatUiControllerProvider sessionId="one" appendGeneratedText={(id, text) => ref.current!.appendGeneratedText(id, text)}>
    <ReportConversation inputRef={ref} />
  </ChatUiControllerProvider>;
}
function ReportConversation({ inputRef }: { inputRef: React.RefObject<ChatInputComposerHandle | null> }) {
  const pending = useChatStore(s => s.pendingOptimisticBySession.one);
  const state = usePersistentReport('one', true, mockApi as any, undefined, pending);
  const { setNotice } = useChatUiActions();
  const send = usePersistentReportSend('one', mockApi as any, state.entries, state.server, 'completed', setNotice);
  return <ChatBody sessionId="one" presentation="manuscript" showSessionAuxiliary={false}
    inputComposerRef={inputRef} getReportSendContext={state.getSendContext}
    reportView={<PersistentReportPager entries={send.entries} index={state.index} api={mockApi as any} send={send}
      onSelect={state.select} onDismiss={state.dismiss} onFocusComposer={() => inputRef.current?.focusAccessibility()} />} />;
}
async function openReport() {
  useSessionStore.setState({ persistentReportsBySession: { one: { entries: [report] } } } as any);
  const screen = render(<ReportHost />);
  await waitFor(() => expect(screen.getByTestId('report-track')).toBeTruthy());
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 200 } } });
  return screen;
}
test('direct answer preserves the real draft and has no undo, then failure/retry/server projection', async () => {
  const screen = await openReport();
  const input = () => screen.getByTestId('chat-composer-text-input');
  fireEvent.changeText(input(), '쓰던 글');
  let reject!: (error: Error) => void;
  mockApi.intervene.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  fireEvent.press(screen.getByLabelText('응'));
  expect(input().props.value).toBe('쓰던 글');
  expect(screen.queryByLabelText('되돌리기')).toBeNull();
  expect(screen.getByTestId('report-received')).toBeTruthy();
  expect(screen.queryByLabelText('취소 요청')).toBeNull();
  expect(mockApi.intervene).toHaveBeenCalledWith('one', '예산 확인: 응', undefined,
    [{ key: 'persistent_report_reply', content: { key: 'ask-one', option: '응' } }]);
  await act(async () => reject(Error('failed')));
  expect(screen.getByLabelText('응')).toBeTruthy();
  mockApi.intervene.mockResolvedValueOnce({ delivered: true });
  await act(async () => fireEvent.press(screen.getByLabelText('응')));
  expect(screen.getByLabelText('취소 요청')).toBeTruthy();
  expect(input().props.value).toBe('쓰던 글');
  act(() => useSessionStore.getState().applyPersistentReport('one', [{ ...report, title: '새 예산 확인', updated_at: 'new' }]));
  expect(screen.getByText('새 예산 확인')).toBeTruthy();
  expect(screen.getByLabelText('응')).toBeTruthy();
  expect(mockListMount).toHaveBeenCalledTimes(1); expect(mockListUnmount).not.toHaveBeenCalled();
});
test('ordinary composer messages only carry visible report context', async () => {
  const screen = await openReport();
  fireEvent.changeText(screen.getByTestId('chat-composer-text-input'), '예산 확인: 응 대신 보류합니다');
  mockApi.intervene.mockResolvedValueOnce({ delivered: true });
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-send-button')));
  expect(mockApi.intervene).toHaveBeenCalledWith('one', '예산 확인: 응 대신 보류합니다', undefined,
    [{ key: 'persistent_report_visible', content: { key: 'ask-one', title: '예산 확인' } }]);
  expect(screen.queryByTestId('report-received')).toBeNull();
});
test('unrelated failed message prevents direct send and uses the sticky composer notice', async () => {
  const screen = await openReport();
  fireEvent.changeText(screen.getByTestId('chat-composer-text-input'), '남길 글');
  const pending = { ...createOptimisticUserEvent('다른 실패한 글', 'user_message'), pendingStatus: 'failed' as const };
  act(() => useChatStore.getState().setPendingOptimistic('one', pending));
  fireEvent.press(screen.getByLabelText('응'));
  expect(screen.getByTestId('chat-composer-generated-notice-row')
    .findByProps({ testID: 'chat-ui-action-notice' }).props.children).toBe(FAILED_REPORT_SEND_REMAINS);
  expect(screen.getByTestId('chat-composer-text-input').props.value).toBe('남길 글');
  expect(mockApi.intervene).not.toHaveBeenCalled();
});

test('failed dismiss restores the same report and uses the sticky composer notice line', async () => {
  const see = { ...report, kind: 'see' as const, options: [] };
  useSessionStore.setState({ persistentReportsBySession: { one: { entries: [see] } } } as any);
  mockApi.dismissPersistentReport.mockRejectedValueOnce(Error('공개 예시 내림 실패'));
  const screen = render(<ReportHost />);
  await waitFor(() => expect(screen.getByTestId('report-track')).toBeTruthy());
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent.changeText(screen.getByTestId('chat-composer-text-input'), '남길 초안');
  await act(async () => fireEvent.press(screen.getByLabelText('봤다')));
  expect(screen.getByTestId('report-sheet-ask-one')).toBeTruthy();
  const row = screen.getByTestId('chat-composer-generated-notice-row');
  expect(row.findByProps({ testID: 'chat-ui-action-notice' }).props.children).toBe('보고를 내리지 못했어.');
  expect(screen.getByTestId('chat-composer-text-input').props.value).toBe('남길 초안');
  mockApi.intervene.mockResolvedValueOnce({ delivered: true });
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-send-button')));
  expect(screen.queryByTestId('chat-composer-generated-notice-row')).toBeNull();
});

test('two consecutive dismissals with only one failure restore only the failed sheet and show the notice', async () => {
  const a = { ...report, kind: 'see' as const, key: 'a', title: '첫째 보고', options: [] };
  const b = { ...a, key: 'b', title: '둘째 보고' };
  useSessionStore.setState({ persistentReportsBySession: { one: { entries: [a, b] } } } as any);
  let rejectA!: (error: Error) => void, resolveB!: (value: any) => void;
  mockApi.dismissPersistentReport.mockImplementationOnce(() => new Promise((_done, fail) => { rejectA = fail; }))
    .mockImplementationOnce(() => new Promise(done => { resolveB = done; }));
  const screen = render(<ReportHost />);
  await waitFor(() => expect(screen.getByTestId('report-track')).toBeTruthy());
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent.press(screen.getByLabelText('봤다'));
  expect(screen.queryByText('첫째 보고')).toBeNull();
  fireEvent.press(screen.getByLabelText('봤다'));
  expect(screen.queryByTestId('report-deck')).toBeNull();
  await act(async () => resolveB({ ok: true, persistent_report: [a] }));
  expect(screen.queryByTestId('report-deck')).toBeNull();
  await act(async () => rejectA(Error('첫째 내림 실패')));
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  expect(screen.getByText('첫째 보고')).toBeTruthy();
  expect(screen.queryByText('둘째 보고')).toBeNull();
  expect(screen.getByTestId('chat-composer-generated-notice-row')
    .findByProps({ testID: 'chat-ui-action-notice' }).props.children).toBe('보고를 내리지 못했어.');
});
