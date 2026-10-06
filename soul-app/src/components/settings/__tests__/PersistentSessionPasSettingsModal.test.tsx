import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { ApiHttpError } from '../../../api/clientCore';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { useChatStore } from '../../../store/chatStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { AppKeyboardAvoidingView } from '../../AppKeyboardAvoidingView';
import { PersistentSessionPasSettingsModal } from '../PersistentSessionPasSettingsModal';
import { normalizePersistentHistory, persistentHistoryForTurnPairing } from '../PersistentSessionMonitoring';

const session = (overrides: Record<string, unknown> = {}) => ({
  session_id: 'pas-1', display_name: '관제 세션', node_id: 'node-a', folder_id: 'folder-a', agent_id: 'agent-a', agent_name: '에이전트 A', persistent: true,
  settings: {
    default_model: { model_preset: 'model-a', reasoning_effort: null },
    fallback_model: null,
    show_character: true,
    animate_character: false,
    show_generation_separator: true,
    show_jev_candidates: false,
    show_turn_usage: true,
  },
  runtime: {
    current_model: { model_preset: 'model-a', reasoning_effort: null, model: 'model-a-live' },
    pending: { target_model_preset: 'model-b', target_reasoning_effort: 'high' },
  },
  ...overrides,
});

const api = {
  getPersistentSession: jest.fn(),
  updatePersistentSession: jest.fn(),
  listModelPresets: jest.fn(),
  getTimeline: jest.fn(),
};

beforeEach(() => {
  jest.mocked(createApiClient).mockReturnValue(api as never);
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getPersistentSession.mockResolvedValue({ session: session() });
  api.updatePersistentSession.mockImplementation(async (_id: string, input: { settings?: Record<string, boolean> }) => ({
    session: session({ settings: { ...session().settings, ...input.settings } }), model_change: 'none',
  }));
  api.listModelPresets.mockResolvedValue({ model_presets: [
    { id: 'model-a', label: '모델 A', backend: 'claude', available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
      weekly_headroom: { status: 'ok', headroom: 12.5, remaining_percent: 72.5, window_remaining_percent: 60, resets_at: '2026-10-06T14:00:00Z', observed_at: '2026-10-06T01:00:00Z', quota_label: '7일' } },
    { id: 'model-b', label: '모델 B', backend: 'codex', available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false, default_effort: 'high',
      weekly_headroom: { status: 'unavailable', headroom: null, remaining_percent: null, window_remaining_percent: null, resets_at: null, observed_at: '2026-10-06T01:00:00Z', quota_label: null } },
  ] });
  api.getTimeline.mockResolvedValue({ messages: [], next_cursor: null });
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
  useChatStore.setState({ persistentDisplaySettings: null, persistentDisplaySettingsRequestId: 0 });
});

const open = () => render(<PersistentSessionPasSettingsModal sessionId="pas-1" nodeId="node-a" onClose={jest.fn()} />);

test('shows the same account and model fields as the ordinary editor, including current, pending, and default', async () => {
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-account-model'));

  expect(await screen.findByLabelText('세션 이름')).toBeTruthy();
  expect(screen.getAllByText('계정과 모델')).toHaveLength(1);
  expect(screen.getByText('현재 실행 모델')).toBeTruthy();
  expect(screen.getByText('대기 중인 변경')).toBeTruthy();
  expect(screen.getByText('다음 실행부터 모델 B')).toBeTruthy();
  expect(screen.getByText('기본 모델')).toBeTruthy();
});

test('saves a PAS display toggle as one immediate field and adopts the server response', async () => {
  const response = session({ settings: { ...session().settings, show_character: false } });
  api.updatePersistentSession.mockResolvedValueOnce({ session: response, model_change: 'none' });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));
  await screen.findByTestId('persistent-show-character');

  await waitFor(() => expect(screen.getByTestId('persistent-show-character').props.value).toBe(true));
  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);
  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', { settings: { show_character: false } }));
  await waitFor(() => expect(screen.getByTestId('persistent-show-character').props.value).toBe(false));
  expect(screen.queryByText('실행 노드')).toBeNull();
});

test('keeps unsaved account edits when an immediate display update succeeds', async () => {
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '수정한 이름');
  fireEvent.press(await screen.findByText('모델 B', { exact: true }));
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));
  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);

  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', { settings: { show_character: false } }));
  await waitFor(() => expect(screen.getByTestId('persistent-show-character').props.value).toBe(false));
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-account-model'));
  expect(screen.getByLabelText('세션 이름').props.value).toBe('수정한 이름');
  expect(screen.getByRole('button', { name: '모델 B' }).props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('persistent-pas-settings-save').props.disabled).toBeFalsy();
});

test('applies a successful display update to the open chat after the settings modal unmounts', async () => {
  let resolveUpdate!: (result: { session: ReturnType<typeof session>; model_change: 'none' }) => void;
  api.updatePersistentSession.mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));
  await screen.findByTestId('persistent-show-character');

  await act(async () => {
    const requestId = useChatStore.getState().beginPersistentDisplaySettingsLoad('pas-1');
    useChatStore.getState().finishPersistentDisplaySettingsLoad('pas-1', requestId, {
      show_generation_separator: true,
      show_jev_candidates: false,
      show_character: true,
      animate_character: false,
      show_turn_usage: true,
    });
  });
  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);
  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', { settings: { show_character: false } }));
  for (const testID of [
    'persistent-show-character',
    'persistent-animate-character',
    'persistent-show-generation-separator',
    'persistent-show-jev-candidates',
    'persistent-show-turn-usage',
  ]) expect(screen.getByTestId(testID).props.disabled).toBe(true);

  screen.unmount();
  await act(async () => {
    resolveUpdate({ session: session({ settings: { ...session().settings, show_character: false } }), model_change: 'none' });
  });

  expect(useChatStore.getState().persistentDisplaySettings).toEqual({
    sessionId: 'pas-1',
    requestId: 2,
    settings: {
      show_generation_separator: true,
      show_jev_candidates: false,
      show_character: false,
      animate_character: false,
      show_turn_usage: true,
    },
  });
});

test('shows pending feedback on the account save action', async () => {
  api.updatePersistentSession.mockImplementation(() => new Promise(() => {}));
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '저장 대기');
  fireEvent.press(screen.getByTestId('persistent-pas-settings-save'));

  expect(await screen.findByText('저장 중…')).toBeTruthy();
});

test('keeps the account save action in the modal footer', async () => {
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');

  expect(screen.getByTestId('persistent-session-pas-settings-footer')).toBeTruthy();
  expect(screen.getByTestId('persistent-pas-settings-save')).toBeTruthy();
});

test('uses the standard keyboard avoiding wrapper around the fixed save action', async () => {
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');

  const keyboardAvoider = screen.UNSAFE_getByType(AppKeyboardAvoidingView);
  expect(keyboardAvoider.props.behavior).toBe(Platform.OS === 'ios' ? 'padding' : undefined);
  expect(keyboardAvoider.props.testID).toBe('persistent-session-pas-settings-modal');
});

test('indicates a display save in progress by disabling switches without adding a status row', async () => {
  api.updatePersistentSession.mockImplementation(() => new Promise(() => {}));
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));
  await screen.findByTestId('persistent-show-character');

  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);

  await waitFor(() => expect(screen.getByTestId('persistent-show-character').props.disabled).toBe(true));
  expect(screen.queryByLabelText('저장 중')).toBeNull();
});

test('keeps the saved switch value when the immediate update fails', async () => {
  api.updatePersistentSession.mockRejectedValueOnce(new ApiHttpError('failed', 503, JSON.stringify({ error: { code: 'NODE_UNAVAILABLE', message: 'unavailable' } })));
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));

  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);
  await waitFor(() => expect(screen.getByTestId('persistent-show-character').props.value).toBe(true));
  expect(await screen.findByText('저장 실패. 다시 눌러 주세요.')).toBeTruthy();
});

test('loads real monitoring data and distinguishes an empty timeline from a failed read', async () => {
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  expect(api.getTimeline).toHaveBeenCalledWith('pas-1', { eventTypes: ['generation_started'], limit: 1 });
  expect(api.getTimeline).toHaveBeenCalledWith('pas-1', {
    eventTypes: ['generation_started', 'complete', 'context_usage', 'error', 'user_message', 'intervention_sent'],
    limit: 100,
  });
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));
  expect(screen.getAllByText('기록')).toHaveLength(1);
  expect(await screen.findByText('기록 없음')).toBeTruthy();
  expect(screen.queryByText('세대 기록 없음')).toBeNull();
  expect(screen.getAllByText('기록 없음', { exact: true })).toHaveLength(1);
  expect(screen.getByTestId('persistent-session-monitoring-empty')).toBeTruthy();

  screen.unmount();
  api.getTimeline.mockRejectedValue(new Error('offline'));
  const failed = open();
  await failed.findByTestId('persistent-session-pas-editor');
  fireEvent.press(failed.getByTestId('settings-segment-pas-settings-history'));
  expect(await failed.findByText('조회 실패')).toBeTruthy();
  expect(failed.getAllByText('다시 시도')).toHaveLength(1);
});

test('retries a failed timeline read in the open monitoring section', async () => {
  let calls = 0;
  api.getTimeline.mockImplementation(async (_id: string, query?: { eventTypes?: string[] }) => {
    calls += 1;
    if (calls <= 2) throw new Error('offline');
    if (query?.eventTypes?.length === 1) return { messages: [], next_cursor: null };
    return { messages: [], next_cursor: null };
  });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));
  fireEvent.press(await screen.findByTestId('persistent-session-monitoring-retry'));

  expect(await screen.findByTestId('persistent-session-monitoring-empty')).toBeTruthy();
  expect(calls).toBe(4);
});

test('shows current monitoring values and pairs usage with the terminal event', async () => {
  api.getTimeline.mockImplementation(async (_id: string, query?: { eventTypes?: string[] }) => {
    if (query?.eventTypes?.length === 1) {
      return { messages: [{ id: 3, parent_event_id: null, event_type: 'generation_started', payload: { generation: 4 }, created_at: '2026-10-05T10:00:00Z' }], next_cursor: null };
    }
    return { messages: [
      { id: 9, parent_event_id: null, event_type: 'complete', payload: { turn_cost_usd: 0.13, usage: { input_tokens: 1200, output_tokens: 45 } }, created_at: '2026-10-05T10:01:00Z' },
      { id: 8, parent_event_id: null, event_type: 'context_usage', payload: { percent: 25, estimated: false }, created_at: '2026-10-05T10:00:59Z' },
      { id: 7, parent_event_id: null, event_type: 'generation_started', payload: { generation: 4 }, created_at: '2026-10-05T10:00:00Z' },
    ], next_cursor: null };
  });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));

  const monitoring = within(screen.getByTestId('settings-section-persistent-session-monitoring'));
  expect(await monitoring.findByText('현재 세대')).toBeTruthy();
  expect(monitoring.getByText('4')).toBeTruthy();
  expect(monitoring.getAllByText('세대 4')).toHaveLength(1);
  expect(monitoring.queryByText('현재 정보')).toBeNull();
  expect(monitoring.getByText('최근 기록', { exact: true })).toBeTruthy();
  expect(monitoring.queryByText(/최근 기록\s*\//)).toBeNull();
  expect(monitoring.queryByText('턴 완료', { exact: true })).toBeNull();
  expect(monitoring.queryByText('현재 실행 모델')).toBeNull();
  expect(monitoring.queryByText('대기 중인 변경')).toBeNull();
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-account-model'));
  expect(screen.getAllByText('현재 정보')).toHaveLength(1);
  expect(screen.getByText('모델 A · model-a-live')).toBeTruthy();
  expect(screen.getByText('다음 실행부터 모델 B')).toBeTruthy();
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));
  expect(monitoring.getByText(/컨텍스트 25\.0% · 정가 \$0\.13/)).toBeTruthy();
});

test('does not pair context usage from a failed turn with a later completion', async () => {
  api.getTimeline.mockImplementation(async (_id: string, query?: { eventTypes?: string[] }) => {
    if (query?.eventTypes?.length === 1) {
      return { messages: [{ id: 5, parent_event_id: null, event_type: 'generation_started', payload: { generation: 5 }, created_at: '2026-10-05T10:02:00Z' }], next_cursor: null };
    }
    return { messages: [
      { id: 4, parent_event_id: null, event_type: 'complete', payload: {}, created_at: '2026-10-05T10:01:03Z' },
      { id: 3, parent_event_id: null, event_type: 'user_message', payload: {}, created_at: '2026-10-05T10:01:02Z' },
      { id: 2, parent_event_id: null, event_type: 'error', payload: {}, created_at: '2026-10-05T10:01:01Z' },
      { id: 1, parent_event_id: null, event_type: 'context_usage', payload: { percent: 51, estimated: false }, created_at: '2026-10-05T10:01:00Z' },
    ], next_cursor: null };
  });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));

  const monitoring = screen.getByTestId('settings-section-persistent-session-monitoring');
  expect(await within(monitoring).findByText('기록 없음')).toBeTruthy();
  expect(within(monitoring).queryByText(/51\.0%/)).toBeNull();
});

test('normalizes overlapping timeline pages by unique id and descending timestamp/id', () => {
  const firstPage = [
    { id: 5, parent_event_id: null, event_type: 'complete', payload: {}, created_at: '2026-10-05T10:02:00Z' },
    { id: 3, parent_event_id: null, event_type: 'user_message', payload: {}, created_at: '2026-10-05T10:04:00Z' },
    { id: 4, parent_event_id: null, event_type: 'error', payload: {}, created_at: '2026-10-05T10:03:00Z' },
  ];
  const overlappingNextPage = [
    { id: 3, parent_event_id: null, event_type: 'user_message', payload: {}, created_at: '2026-10-05T10:01:00Z' },
    { id: 2, parent_event_id: null, event_type: 'context_usage', payload: {}, created_at: '2026-10-05T10:05:00Z' },
    { id: 1, parent_event_id: null, event_type: 'generation_started', payload: {}, created_at: '2026-10-05T10:00:00Z' },
  ];
  const combined = [...firstPage, ...overlappingNextPage];
  const normalized = normalizePersistentHistory(combined);
  const pairingEvents = persistentHistoryForTurnPairing(combined);

  expect(normalized.map((event) => event.id)).toEqual([2, 3, 4, 5, 1]);
  expect(pairingEvents.map((event) => event.id)).toEqual([1, 2, 3, 4, 5]);
});

test('shows actual quota snapshots for current/default and fallback model providers', async () => {
  api.getPersistentSession.mockResolvedValueOnce({ session: session({
    settings: { ...session().settings, fallback_model: { model_preset: 'model-b', reasoning_effort: 'high' } },
  }) });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');

  expect(await screen.findByText('Claude · 현재·기본')).toBeTruthy();
  expect(screen.getByText('7일 여유 12.5%')).toBeTruthy();
  expect(screen.queryByText(/72\.5%/)).toBeNull();
  expect(screen.getByText(/초기화 .* · 관측/)).toBeTruthy();
  expect(screen.getByText('Codex · 대체')).toBeTruthy();
  expect(screen.getByText('기록 없음')).toBeTruthy();
  expect(screen.queryByText(/0%/)).toBeNull();
});

test('shows negative weekly headroom exactly as received', async () => {
  api.listModelPresets.mockResolvedValueOnce({ model_presets: [
    { id: 'model-a', label: '모델 A', backend: 'claude', available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
      weekly_headroom: { status: 'ok', headroom: -56.6, remaining_percent: 21, window_remaining_percent: 77.6, resets_at: null, observed_at: '2026-10-06T01:00:00Z', quota_label: '7일' } },
    { id: 'model-b', label: '모델 B', backend: 'codex', available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
      weekly_headroom: { status: 'unavailable', headroom: null, remaining_percent: null, window_remaining_percent: null, resets_at: null, observed_at: null, quota_label: null } },
  ] });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');

  expect(await screen.findByText('7일 여유 -56.6%')).toBeTruthy();
  expect(screen.queryByText(/21%/)).toBeNull();
});

test('distinguishes model preset quota loading from a failed read', async () => {
  api.listModelPresets.mockImplementation(() => new Promise(() => {}));
  const loading = open();
  await loading.findByTestId('persistent-session-pas-editor');
  expect(await loading.findByLabelText('계정 여유 불러오는 중')).toBeTruthy();

  loading.unmount();
  api.listModelPresets.mockRejectedValueOnce(new Error('offline'));
  const failed = open();
  await failed.findByTestId('persistent-session-pas-editor');
  expect(failed.getByTestId('settings-segment-pas-settings-account-model')).toBeTruthy();
  expect(await failed.findByText('조회 실패')).toBeTruthy();
});
