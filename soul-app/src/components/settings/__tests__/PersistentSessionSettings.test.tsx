import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

let mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockDimensions }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import { SettingsScreen } from '../../../screens/SettingsScreen';
import { useAuthStore } from '../../../store/authStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';

const resource = (over: Record<string, unknown> = {}) => ({
  session_id: 'pas-1', display_name: '관제 세션', node_id: 'node-a', folder_id: 'folder-a', agent_id: 'agent-a', agent_name: '에이전트 A', persistent: true,
  settings: { default_model: { model_preset: 'model-a', reasoning_effort: null } },
  runtime: { current_model: { model_preset: 'model-a', reasoning_effort: null, model: 'model-a-real' }, pending: null },
  ...over,
});
const second = resource({ session_id: 'pas-2', display_name: '두 번째 세션' });
const createDefaults = {
  node_id: 'node-a', preferred_agent_id: 'agent-a', settings: { default_model: { model_preset: 'model-a', reasoning_effort: null } },
  initial_instruction: '서버가 정한 첫 인사 문장', unavailable_reason: null,
};
const api = {
  getConfig: jest.fn(), getAuthStatus: jest.fn(),
  listPersistentSessions: jest.fn(), getPersistentSession: jest.fn(), updatePersistentSession: jest.fn(), createPersistentSession: jest.fn(),
  listNodeAgents: jest.fn(), listModelPresets: jest.fn(),
};
const failure = (status: number, code: string, message: string, extra: object = {}) => new ApiHttpError('failed', status, JSON.stringify({ error: { code, message }, ...extra }));

beforeEach(() => {
  mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
  (createApiClient as jest.Mock).mockReturnValue(api);
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getConfig.mockResolvedValue({ mode: 'single' });
  api.getAuthStatus.mockResolvedValue({ authenticated: true, user: { isAdmin: false } });
  api.listPersistentSessions.mockResolvedValue({ sessions: [resource(), second], total: 2, create_defaults: createDefaults });
  api.getPersistentSession.mockImplementation(async (id: string) => ({ session: id === 'pas-2' ? second : resource() }));
  api.updatePersistentSession.mockResolvedValue({ session: resource(), model_change: 'none' });
  api.createPersistentSession.mockResolvedValue({ session: resource({ session_id: 'pas-new' }), creation: 'started', warnings: [] });
  api.listNodeAgents.mockResolvedValue({ agents: [{ id: 'agent-a', name: '에이전트 A' }, { id: 'agent-b', name: '에이전트 B' }] });
  api.listModelPresets.mockResolvedValue({ model_presets: [
    { id: 'model-a', label: '모델 A', backend: 'claude', available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false },
    { id: 'model-b', label: '모델 B', backend: 'codex', available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false, default_effort: 'high' },
    { id: 'model-down', label: '모델 C', backend: 'codex', available: false, reason: 'limit', reason_label: '사용량 한도', resets_at: null, usage_warning: false },
  ] });
  useAuthStore.setState({ jwt: null });
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
  useSessionStore.setState({ catalog: { folders: [{ id: 'folder-a', name: '폴더 A' }], sessions: {} } as never });
});
afterEach(() => jest.restoreAllMocks());

async function openList() {
  const screen = render(<SettingsScreen showAdmin={false} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('settings-category-persistent'));
  await screen.findByTestId('persistent-session-pas-1');
  return screen;
}
async function openEditor(screen: Awaited<ReturnType<typeof openList>>, id = 'pas-1') {
  fireEvent.press(screen.getByTestId(`persistent-session-${id}`));
  return screen.findByTestId('persistent-session-editor');
}

test('lists every registered session, edits name and model, saves from the footer and returns to the list', async () => {
  const screen = await openList();
  expect(screen.getByTestId('persistent-session-pas-2')).toBeTruthy();
  expect(screen.queryByTestId('settings-active-footer')).toBeNull();

  await openEditor(screen);
  await waitFor(() => expect(screen.getByLabelText('세션 이름').props.value).toBe('관제 세션'));
  expect(screen.getByText('에이전트 A')).toBeTruthy();
  expect(screen.getByText('현재 실행 모델')).toBeTruthy();
  expect(screen.getByText('대기 중인 변경 없음')).toBeTruthy();
  expect(screen.getByTestId('settings-active-footer')).toBeTruthy();

  fireEvent.changeText(screen.getByLabelText('세션 이름'), '새 이름');
  fireEvent.press(await screen.findByText('모델 B'));
  fireEvent.press(screen.getByTestId('settings-scope-save'));
  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', {
    display_name: '새 이름', settings: { default_model: { model_preset: 'model-b', reasoning_effort: 'high' } },
  }));
  await waitFor(() => expect(screen.queryByTestId('persistent-session-editor')).toBeNull());
  expect(screen.queryByTestId('settings-active-footer')).toBeNull();
  expect(api.listPersistentSessions).toHaveBeenCalledTimes(2);
});

test('keeps the recorded reasoning effort when the model choice is unchanged', async () => {
  api.getPersistentSession.mockResolvedValue({ session: resource({ settings: { default_model: { model_preset: 'model-b', reasoning_effort: 'low' } } }) });
  const screen = await openList();
  await openEditor(screen);
  await waitFor(() => expect(screen.getByLabelText('세션 이름').props.value).toBe('관제 세션'));
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '이름만 변경');
  fireEvent.press(screen.getByTestId('settings-scope-save'));
  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', {
    display_name: '이름만 변경', settings: { default_model: { model_preset: 'model-b', reasoning_effort: 'low' } },
  }));
});

test('shows the pending change, and asks to save again when default and current models differ with nothing pending', async () => {
  const differing = resource({ settings: { default_model: { model_preset: 'model-b', reasoning_effort: null } } });
  api.getPersistentSession.mockResolvedValue({ session: differing });
  let screen = await openList();
  await openEditor(screen);
  expect(await screen.findByText('기본 모델 변경 요청이 없습니다. 다시 저장해 주세요.')).toBeTruthy();
  screen.unmount();

  api.getPersistentSession.mockResolvedValue({ session: { ...differing, runtime: { ...differing.runtime, pending: { target_model_preset: 'model-b', target_reasoning_effort: null } } } });
  screen = await openList();
  await openEditor(screen);
  expect(await screen.findByText('다음 실행부터 모델 B')).toBeTruthy();
  expect(screen.queryByText('기본 모델 변경 요청이 없습니다. 다시 저장해 주세요.')).toBeNull();
});

test('an unavailable model is not selected and the reason is shown; the name can still be saved', async () => {
  const screen = await openList();
  await openEditor(screen);
  await waitFor(() => expect(screen.getByLabelText('세션 이름').props.value).toBe('관제 세션'));
  fireEvent.press(await screen.findByText('모델 C'));
  expect(await screen.findByText('모델 C은(는) 지금 선택할 수 없습니다: 사용량 한도')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '이름');
  fireEvent.press(screen.getByTestId('settings-scope-save'));
  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', expect.objectContaining({
    settings: { default_model: { model_preset: 'model-a', reasoning_effort: null } },
  })));
});

test('keeps the input and shows a partial-save notice when a save fails after the server started', async () => {
  api.updatePersistentSession.mockRejectedValue(failure(503, 'NODE_COMMAND_TIMEOUT', '노드가 응답하지 않았습니다.'));
  const screen = await openList();
  await openEditor(screen);
  await waitFor(() => expect(screen.getByLabelText('세션 이름').props.value).toBe('관제 세션'));
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '유지될 입력');
  fireEvent.press(screen.getByTestId('settings-scope-save'));
  expect(await screen.findByText('노드가 제때 응답하지 않았습니다. 일부 변경이 저장됐을 수 있습니다. 다시 읽거나 저장해 주세요.')).toBeTruthy();
  expect(screen.getByLabelText('세션 이름').props.value).toBe('유지될 입력');
  expect(screen.getByTestId('persistent-session-editor')).toBeTruthy();
});

test('adds a session with the server defaults and no first message constant of its own', async () => {
  const screen = await openList();
  fireEvent.press(screen.getByTestId('persistent-session-create'));
  await screen.findByTestId('persistent-session-editor');
  await waitFor(() => expect(screen.getByLabelText('첫 메시지 (선택)').props.placeholder).toBe('서버가 정한 첫 인사 문장'));
  expect(screen.getByText('node-a')).toBeTruthy();
  expect(api.listNodeAgents).toHaveBeenCalledWith('node-a');
  expect(api.listModelPresets).toHaveBeenCalledWith('node-a');
  expect(screen.getByText('세션 추가')).toBeTruthy();

  fireEvent.press(screen.getByTestId('settings-scope-save'));
  expect(api.createPersistentSession).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '새 영구 세션');
  fireEvent.press(await screen.findByText('폴더 A'));
  fireEvent.press(screen.getByTestId('settings-scope-save'));
  await waitFor(() => expect(api.createPersistentSession).toHaveBeenCalledWith({
    display_name: '새 영구 세션', agent_id: 'agent-a', folder_id: 'folder-a', initial_instruction: '',
    settings: { default_model: { model_preset: 'model-a', reasoning_effort: null } },
  }));
  await waitFor(() => expect(screen.queryByTestId('persistent-session-editor')).toBeNull());
});

test('a registration failure keeps the created id and retries only the registration', async () => {
  api.createPersistentSession.mockRejectedValue(failure(503, 'PERSISTENT_REGISTRATION_FAILED', '이름과 설정을 기록하지 못했습니다.', {
    created_session: { session_id: 'created-1', display_name: '입력한 이름' },
  }));
  const screen = await openList();
  fireEvent.press(screen.getByTestId('persistent-session-create'));
  await screen.findByTestId('persistent-session-editor');
  await waitFor(() => expect(screen.getByLabelText('첫 메시지 (선택)').props.placeholder).toBe('서버가 정한 첫 인사 문장'));
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '입력한 이름');
  fireEvent.press(await screen.findByText('폴더 A'));
  fireEvent.press(screen.getByTestId('settings-scope-save'));
  expect(await screen.findByText('세션은 만들어졌으나 등록하지 못했습니다. (입력한 이름)')).toBeTruthy();
  expect(screen.getByLabelText('세션 이름').props.value).toBe('입력한 이름');

  fireEvent.press(screen.getByTestId('persistent-registration-retry'));
  await waitFor(() => expect(api.updatePersistentSession).toHaveBeenCalledWith('created-1', {
    display_name: '입력한 이름', enabled: true, settings: { default_model: { model_preset: 'model-a', reasoning_effort: null } },
  }));
  expect(api.createPersistentSession).toHaveBeenCalledTimes(1);
});

test('releasing asks first, then sends enabled=false and the item leaves the list', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = await openList();
  await openEditor(screen);
  await waitFor(() => expect(screen.getByLabelText('세션 이름').props.value).toBe('관제 세션'));
  expect(screen.getByText('해제해도 세션과 대화 기록은 남습니다.')).toBeTruthy();

  fireEvent.press(screen.getByTestId('persistent-session-release'));
  const [title, message, buttons] = alert.mock.calls[0];
  expect(title).toBe('영구 세션 해제');
  expect(message).toContain('세션과 대화 기록은 남습니다');
  expect(buttons?.map((button) => [button.text, button.style])).toEqual([['취소', 'cancel'], ['해제', 'destructive']]);
  expect(api.updatePersistentSession).not.toHaveBeenCalled();

  api.listPersistentSessions.mockResolvedValue({ sessions: [second], total: 1, create_defaults: createDefaults });
  await act(async () => { buttons?.[1].onPress?.(); });
  expect(api.updatePersistentSession).toHaveBeenCalledWith('pas-1', { enabled: false });
  await waitFor(() => expect(screen.queryByTestId('persistent-session-pas-1')).toBeNull());
  expect(screen.getByTestId('persistent-session-pas-2')).toBeTruthy();
});

test('a failed list read shows the error and a retry, never an empty list', async () => {
  api.listPersistentSessions.mockRejectedValueOnce(failure(503, 'NODE_UNAVAILABLE', '목록을 불러오지 못했습니다.'));
  const screen = render(<SettingsScreen showAdmin={false} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('settings-category-persistent'));
  expect(await screen.findByText('세션이 있는 노드에 연결할 수 없습니다.')).toBeTruthy();
  expect(screen.queryByText('등록된 영구 에이전트 세션이 없습니다.')).toBeNull();
  fireEvent.press(screen.getByTestId('persistent-sessions-retry'));
  expect(await screen.findByTestId('persistent-session-pas-1')).toBeTruthy();
});

test('an empty server list says so and offers the add button', async () => {
  api.listPersistentSessions.mockResolvedValue({ sessions: [], total: 0, create_defaults: createDefaults });
  const screen = render(<SettingsScreen showAdmin={false} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('settings-category-persistent'));
  expect(await screen.findByText('등록된 영구 에이전트 세션이 없습니다.')).toBeTruthy();
  expect(screen.getByTestId('persistent-session-create')).toBeTruthy();
});

test('back goes editor, then the PAS list, then the settings list; unsaved input asks first', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = await openList();
  await openEditor(screen);
  await waitFor(() => expect(screen.getByLabelText('세션 이름').props.value).toBe('관제 세션'));
  fireEvent.changeText(screen.getByLabelText('세션 이름'), '고친 이름');
  fireEvent.press(screen.getByLabelText('영구 에이전트 세션 이전 화면으로 돌아가기'));
  expect(alert).toHaveBeenCalledWith('저장하지 않은 변경', expect.any(String), expect.any(Array));
  expect(screen.getByTestId('persistent-session-editor')).toBeTruthy();

  const discard = (alert.mock.calls[0][2] ?? []).find((button) => button.text === '버리기');
  await act(async () => { discard?.onPress?.(); });
  expect(screen.queryByTestId('persistent-session-editor')).toBeNull();
  expect(screen.queryByLabelText('영구 에이전트 세션 이전 화면으로 돌아가기')).toBeNull();
  expect(screen.getByTestId('settings-phone-index', { includeHiddenElements: true }).props.importantForAccessibility).toBe('no-hide-descendants');

  fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  expect(screen.getByTestId('settings-phone-index', { includeHiddenElements: true }).props.importantForAccessibility).toBe('auto');
});
