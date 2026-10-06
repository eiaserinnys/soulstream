import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ApiHttpError } from '../../../api/clientCore';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { useSettingsStore } from '../../../store/settingsStore';
import { PersistentSessionPasSettingsModal } from '../PersistentSessionPasSettingsModal';

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
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));
  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);

  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', { settings: { show_character: false } }));
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-account-model'));
  expect(screen.getByLabelText('세션 이름').props.value).toBe('수정한 이름');
  expect(screen.getByTestId('persistent-pas-settings-save').props.disabled).toBeFalsy();
});

test('shows pending feedback on the account save action', async () => {
  api.updatePersistentSession.mockImplementation(() => new Promise(() => {}));
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '저장 대기');
  fireEvent.press(screen.getByTestId('persistent-pas-settings-save'));

  expect(await screen.findByText('저장 중…')).toBeTruthy();
});

test('keeps the saved switch value when the immediate update fails', async () => {
  api.updatePersistentSession.mockRejectedValueOnce(new ApiHttpError('failed', 503, JSON.stringify({ error: { code: 'NODE_UNAVAILABLE', message: 'unavailable' } })));
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-display'));

  fireEvent(screen.getByTestId('persistent-show-character'), 'valueChange', false);
  await waitFor(() => expect(screen.getByTestId('persistent-show-character').props.value).toBe(true));
  expect(await screen.findByText(/세션이 있는 노드에 연결할 수 없습니다\./)).toBeTruthy();
});

test('loads real monitoring data and distinguishes an empty timeline from a failed read', async () => {
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  expect(api.getTimeline).toHaveBeenCalledWith('pas-1', { eventTypes: ['generation_started'], limit: 1 });
  expect(api.getTimeline).toHaveBeenCalledWith('pas-1', { eventTypes: ['generation_started', 'complete', 'context_usage'], limit: 100 });
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));
  expect(screen.getAllByText('기록')).toHaveLength(1);
  expect(await screen.findByText('세대 기록 없음')).toBeTruthy();
  expect(screen.getByText('기록 없음')).toBeTruthy();

  screen.unmount();
  api.getTimeline.mockRejectedValue(new Error('offline'));
  const failed = open();
  await failed.findByTestId('persistent-session-pas-editor');
  fireEvent.press(failed.getByTestId('settings-segment-pas-settings-history'));
  expect(await failed.findAllByText('조회 실패')).toHaveLength(2);
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

  expect(await screen.findAllByText('세대 4')).toHaveLength(2);
  expect(screen.getByText('모델 A · model-a-live')).toBeTruthy();
  expect(screen.getByText('다음 실행부터 모델 B')).toBeTruthy();
  expect(screen.getByText(/컨텍스트 25\.0% · 정가 \$0\.13/)).toBeTruthy();
});

test('shows actual quota snapshots for current/default and fallback model providers', async () => {
  api.getPersistentSession.mockResolvedValueOnce({ session: session({
    settings: { ...session().settings, fallback_model: { model_preset: 'model-b', reasoning_effort: 'high' } },
  }) });
  const screen = open();
  await screen.findByTestId('persistent-session-pas-editor');
  fireEvent.press(screen.getByTestId('settings-segment-pas-settings-history'));

  expect(await screen.findByText('Claude · 현재·기본')).toBeTruthy();
  expect(screen.getByText(/7일 여유 72\.5% · 초기화 .* · 관측/)).toBeTruthy();
  expect(screen.getByText('Codex · 대체')).toBeTruthy();
  expect(screen.getAllByText('기록 없음')).toHaveLength(2);
  expect(screen.queryByText(/0%/)).toBeNull();
});

test('distinguishes model preset quota loading from a failed read', async () => {
  api.listModelPresets.mockImplementation(() => new Promise(() => {}));
  const loading = open();
  await loading.findByTestId('persistent-session-pas-editor');
  fireEvent.press(loading.getByTestId('settings-segment-pas-settings-history'));
  expect(await loading.findByText('불러오는 중')).toBeTruthy();

  loading.unmount();
  api.listModelPresets.mockRejectedValueOnce(new Error('offline'));
  const failed = open();
  await failed.findByTestId('persistent-session-pas-editor');
  fireEvent.press(failed.getByTestId('settings-segment-pas-settings-history'));
  expect(await failed.findByText('조회 실패')).toBeTruthy();
});
