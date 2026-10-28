jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import type { ClaudeAccount, ClaudeAccountList, ClaudeAuthLoginFlow } from '../../../../../packages/soul-ui/src/lib/usage-summary';
import { ClaudeAccountPoolSection, type ClaudeAccountPoolApi } from '../ClaudeAccountPoolSection';

function account(id: string, priority: number | null, enabled = true): ClaudeAccount {
  return {
    id,
    email: `${id}@example.invalid`,
    plan: 'Max 5x',
    enabled,
    priority,
    auth_state: 'ok',
    usage: {
      five_hour: { used_percent: 24, resets_at: '2026-10-28T12:00:00.000Z' },
      seven_day: { used_percent: 13, resets_at: '2026-10-29T12:00:00.000Z' },
      fable_weekly: { used_percent: 18, resets_at: '2026-10-29T12:00:00.000Z' },
    },
    observed_at: '2026-10-28T09:10:00.000Z',
    blocked: null,
    active_sessions: 0,
  };
}

const initial: ClaudeAccountList = {
  mode: 'pool',
  accounts: [{ ...account('one', 1), active_sessions: 2 }, account('two', 2), account('three', 3)],
  pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 87, best_weekly_resets_at: null, earliest_available_at: null },
  fable_pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 82, best_weekly_resets_at: null, earliest_available_at: null },
};

const loginFlow: ClaudeAuthLoginFlow = {
  login_id: 'login-a', account_id: null, state: 'url_ready',
  auth_url: 'fixture',
  expires_at: '2026-10-28T12:00:00.000Z', error: null,
};

function createApi(): jest.Mocked<ClaudeAccountPoolApi> {
  return {
    getClaudeAuthAccounts: jest.fn().mockResolvedValue(initial),
    patchClaudeAuthAccount: jest.fn().mockImplementation(async (_nodeId, accountId, patch) => ({
      ...initial,
      accounts: initial.accounts.map(entry => entry.id === accountId ? { ...entry, ...patch } : entry),
    })),
    deleteClaudeAuthAccount: jest.fn().mockResolvedValue({ deferred: false, accounts: initial.accounts.slice(1), pool: initial.pool }),
    startClaudeAuthLogin: jest.fn().mockResolvedValue(loginFlow),
    getClaudeAuthLogin: jest.fn().mockResolvedValue(loginFlow),
    submitClaudeAuthLoginCode: jest.fn().mockResolvedValue({ ...loginFlow, state: 'verifying', auth_url: null }),
    cancelClaudeAuthLogin: jest.fn().mockResolvedValue({ ...loginFlow, state: 'cancelled', auth_url: null }),
  };
}

function createMutableApi(list: ClaudeAccountList) {
  let current = list;
  const api = createApi();
  api.getClaudeAuthAccounts.mockImplementation(async () => current);
  api.patchClaudeAuthAccount.mockImplementation(async (_nodeId, accountId, patch) => {
    current = {
      ...current,
      accounts: current.accounts.map(entry => entry.id === accountId ? { ...entry, ...patch } : entry),
    };
    return current;
  });
  return { api, current: () => current };
}

function renderPool(api = createApi(), list = initial) {
  return { api, view: render(<ClaudeAccountPoolSection nodeId="node-a" initialList={list} api={api} />) };
}

test('shows availability once and renders three quota gauges for each account', () => {
  const { view } = renderPool();
  expect(view.getByText('Claude 계정')).toBeTruthy();
  expect(view.getByText('2/3 가용 (주간 최대 잔여 87%)')).toBeTruthy();
  expect(view.getByText('세션 2')).toBeTruthy();
  expect(view.getAllByText('5시간')).toHaveLength(3);
  expect(view.getAllByText('7일')).toHaveLength(3);
  expect(view.getAllByText('Fable')).toHaveLength(3);
  expect(view.getAllByTestId(/^claude-account-row-/)).toHaveLength(3);
});

test('rank arrows PATCH priority and optimistically move the row', async () => {
  const api = createApi();
  let resolvePatch!: (value: ClaudeAccountList) => void;
  api.patchClaudeAuthAccount.mockReturnValueOnce(new Promise(resolve => { resolvePatch = resolve; }));
  const { view } = renderPool(api);

  expect(view.getByTestId('claude-priority-up-one').props.accessibilityState.disabled).toBe(true);
  expect(view.getByTestId('claude-priority-down-three').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(view.getByTestId('claude-priority-up-two'));

  expect(api.patchClaudeAuthAccount).toHaveBeenCalledWith('node-a', 'two', { priority: 0 });
  expect(view.getByText('1순위')).toBeTruthy();
  expect(view.getAllByTestId(/^claude-account-row-/).map(row => row.props.testID)).toEqual([
    'claude-account-row-two', 'claude-account-row-one', 'claude-account-row-three',
  ]);
  await act(async () => resolvePatch({ ...initial, accounts: [account('two', 0), account('one', 1), account('three', 3)] }));
});

test('repeated adjacent moves preserve one-row movement without priority collisions', async () => {
  const { api } = createMutableApi(initial);
  const { view } = renderPool(api);
  const rowIds = () => view.getAllByTestId(/^claude-account-row-/).map(row => row.props.testID);

  fireEvent.press(view.getByTestId('claude-priority-up-three'));
  await waitFor(() => expect(rowIds()).toEqual(['claude-account-row-one', 'claude-account-row-three', 'claude-account-row-two']));
  fireEvent.press(view.getByTestId('claude-priority-down-one'));
  await waitFor(() => expect(rowIds()).toEqual(['claude-account-row-three', 'claude-account-row-one', 'claude-account-row-two']));
  fireEvent.press(view.getByTestId('claude-priority-down-three'));
  await waitFor(() => expect(rowIds()).toEqual(['claude-account-row-one', 'claude-account-row-three', 'claude-account-row-two']));

  expect(api.patchClaudeAuthAccount).toHaveBeenCalledTimes(3);
  expect(api.patchClaudeAuthAccount.mock.calls.map(([, id, patch]) => [id, patch.priority])).toEqual([
    ['three', 1.5], ['one', 1.75], ['three', 1.875],
  ]);
});

test.each([
  ['null priorities', [account('one', null), account('two', null), account('three', null)]],
  ['tied priorities', [account('one', 1), account('two', 1), account('three', 1)]],
] as const)('normalizes %s while preserving the requested adjacent move', async (_description, accounts) => {
  const list = { ...initial, accounts };
  const { api, current } = createMutableApi(list);
  const { view } = renderPool(api, list);

  fireEvent.press(view.getByTestId('claude-priority-up-three'));
  await waitFor(() => expect(view.getAllByTestId(/^claude-account-row-/).map(row => row.props.testID)).toEqual([
    'claude-account-row-one', 'claude-account-row-three', 'claude-account-row-two',
  ]));

  await waitFor(() => expect(current().accounts.map(entry => entry.priority).sort()).toEqual([1, 2, 3]));
  expect(api.patchClaudeAuthAccount.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('normalizes when an enabled move crosses a disabled account slot', async () => {
  const list = { ...initial, accounts: [account('one', 1), account('off', 2, false), account('two', 4)] };
  const { api, current } = createMutableApi(list);
  const { view } = renderPool(api, list);

  fireEvent.press(view.getByTestId('claude-priority-down-one'));
  await waitFor(() => expect(view.getAllByTestId(/^claude-account-row-/).map(row => row.props.testID)).toEqual([
    'claude-account-row-two', 'claude-account-row-off', 'claude-account-row-one',
  ]));
  await waitFor(() => expect(current().accounts.map(entry => entry.priority).sort()).toEqual([1, 2, 3]));
  expect(api.patchClaudeAuthAccount.mock.calls.map(([, id, patch]) => [id, patch.priority])).toEqual([
    ['two', 1], ['one', 3],
  ]);
});

test('toggle PATCHes enabled and deletion uses inline confirmation with deferred feedback', async () => {
  const api = createApi();
  api.deleteClaudeAuthAccount.mockResolvedValueOnce({ deferred: true, accounts: initial.accounts.slice(1), pool: initial.pool });
  const { view } = renderPool(api);

  fireEvent(view.getByTestId('claude-account-toggle-one'), 'valueChange', false);
  await waitFor(() => expect(api.patchClaudeAuthAccount).toHaveBeenCalledWith('node-a', 'one', { enabled: false }));

  fireEvent.press(view.getByTestId('claude-account-delete-two'));
  const confirm = view.getByTestId('claude-account-delete-confirmation-two');
  expect(confirm).toBeTruthy();
  expect(confirm.props.style.borderTopWidth).toBeGreaterThan(0);
  fireEvent.press(view.getByTestId('claude-account-delete-confirm-two'));
  expect(await view.findByText('현재 세션이 끝난 뒤 삭제합니다.')).toBeTruthy();
  expect(api.deleteClaudeAuthAccount).toHaveBeenCalledWith('node-a', 'two');
  expect(api.getClaudeAuthAccounts).toHaveBeenCalledWith('node-a');
});

test('DELETE reloads the complete account list and uses its latest pool summaries', async () => {
  const api = createApi();
  const refreshedList: ClaudeAccountList = {
    ...initial,
    accounts: initial.accounts.filter(entry => entry.id !== 'two'),
    pool: { ...initial.pool!, available_count: 1, total_count: 2, best_weekly_remaining_percent: 74 },
    fable_pool: { ...initial.fable_pool!, available_count: 0, total_count: 2, best_weekly_remaining_percent: 12 },
  };
  api.deleteClaudeAuthAccount.mockResolvedValueOnce({
    deferred: false,
    accounts: refreshedList.accounts,
    pool: initial.pool,
  });
  api.getClaudeAuthAccounts.mockResolvedValueOnce(refreshedList);
  const { view } = renderPool(api);

  fireEvent.press(view.getByTestId('claude-account-delete-two'));
  fireEvent.press(view.getByTestId('claude-account-delete-confirm-two'));

  expect(await view.findByText('1/2 가용 (주간 최대 잔여 74%)')).toBeTruthy();
  expect(view.queryByTestId('claude-account-row-two')).toBeNull();
  expect(view.getAllByTestId(/^claude-account-row-/)).toHaveLength(2);
  expect(api.deleteClaudeAuthAccount).toHaveBeenCalledWith('node-a', 'two');
  expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(1);
  expect(api.getClaudeAuthAccounts).toHaveBeenCalledWith('node-a');
});

test.each([
  ['account_exists', '이미 등록된 계정입니다.', 409],
  ['account_identity_mismatch', '기존 계정과 인증 계정이 일치하지 않습니다.', 409],
  ['invalid_login_code', '인증 코드가 만료되었거나 이미 사용되었습니다.', 400],
] as const)('login opens the returned auth link, prevents duplicate submission, and maps %s', async (code, message, status) => {
  const api = createApi();
  api.submitClaudeAuthLoginCode.mockRejectedValueOnce(Object.assign(new Error('request failed'), {
    status,
    body: JSON.stringify({ code, message: 'server raw message' }),
  }));
  const { view } = renderPool(api);

  fireEvent.press(view.getByLabelText('Claude 계정 추가'));
  await waitFor(() => expect(api.startClaudeAuthLogin).toHaveBeenCalledWith('node-a', undefined));
  fireEvent.press(await view.findByLabelText('인증 페이지 열기'));
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(expect.any(String));

  fireEvent.changeText(view.getByLabelText('인증 코드'), String.fromCharCode(120));
  await act(async () => {
    fireEvent.press(view.getByTestId('claude-login-submit'));
    fireEvent.press(view.getByTestId('claude-login-submit'));
  });
  await waitFor(() => expect(api.submitClaudeAuthLoginCode).toHaveBeenCalledTimes(1));
  expect(await view.findByText(message)).toBeTruthy();
  expect(view.queryByText('server raw message')).toBeNull();
});

test('requested login can be cancelled and the cancelled state closes the panel', async () => {
  const api = createApi();
  api.startClaudeAuthLogin.mockResolvedValueOnce({ ...loginFlow, state: 'requested', auth_url: null });
  api.cancelClaudeAuthLogin.mockResolvedValueOnce({ ...loginFlow, state: 'cancelled', auth_url: null });
  const { view } = renderPool(api);

  fireEvent.press(view.getByLabelText('Claude 계정 추가'));
  expect(await view.findByText('인증 링크를 준비하고 있습니다.')).toBeTruthy();
  fireEvent.press(view.getByLabelText('인증 취소'));
  expect(await view.findByText('인증을 취소했습니다.')).toBeTruthy();
  expect(view.queryByTestId('claude-login-flow')).toBeNull();
});

test('polling exposes a failed flow and stops at the terminal state', async () => {
  jest.useFakeTimers();
  const api = createApi();
  api.startClaudeAuthLogin.mockResolvedValueOnce({ ...loginFlow, state: 'requested', auth_url: null });
  api.getClaudeAuthLogin.mockResolvedValueOnce({ ...loginFlow, state: 'failed', auth_url: null,
    error: { code: 'invalid_code', message: 'private response text' } });
  const { view } = renderPool(api);

  fireEvent.press(view.getByLabelText('Claude 계정 추가'));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(1_000); await Promise.resolve(); });
  expect(view.getByText('인증 코드가 만료되었거나 이미 사용되었습니다.')).toBeTruthy();
  expect(view.queryByText('private response text')).toBeNull();
  expect(api.getClaudeAuthLogin).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test('a failed code-submission flow maps its account error to a readable message', async () => {
  const api = createApi();
  api.submitClaudeAuthLoginCode.mockResolvedValueOnce({ ...loginFlow, state: 'failed', auth_url: null,
    error: { code: 'account_exists', message: 'private response text' } });
  const { view } = renderPool(api);
  fireEvent.press(view.getByLabelText('Claude 계정 추가'));
  await view.findByTestId('claude-login-flow');
  fireEvent.changeText(view.getByLabelText('인증 코드'), String.fromCharCode(120));
  fireEvent.press(view.getByTestId('claude-login-submit'));

  expect(await view.findByText('이미 등록된 계정입니다.')).toBeTruthy();
  expect(view.queryByText('private response text')).toBeNull();
});

test.each(['code_submitted', 'verifying'] as const)('login %s state shows its progress message', async state => {
  const api = createApi();
  api.submitClaudeAuthLoginCode.mockResolvedValueOnce({ ...loginFlow, state, auth_url: null });
  const { view } = renderPool(api);
  fireEvent.press(view.getByLabelText('Claude 계정 추가'));
  await view.findByTestId('claude-login-flow');
  fireEvent.changeText(view.getByLabelText('인증 코드'), String.fromCharCode(120));
  fireEvent.press(view.getByTestId('claude-login-submit'));
  expect(await view.findByText('인증 코드를 확인하고 계정 정보를 가져오는 중입니다.')).toBeTruthy();
});

test('done login state refreshes the account list', async () => {
  const api = createApi();
  api.submitClaudeAuthLoginCode.mockResolvedValueOnce({ ...loginFlow, state: 'done', auth_url: null });
  const { view } = renderPool(api);
  fireEvent.press(view.getByLabelText('Claude 계정 추가'));
  await view.findByTestId('claude-login-flow');
  fireEvent.changeText(view.getByLabelText('인증 코드'), String.fromCharCode(120));
  fireEvent.press(view.getByTestId('claude-login-submit'));

  expect(await view.findByText('Claude 계정이 연결되었습니다.')).toBeTruthy();
  expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('claude-login-flow')).toBeNull();
});

test('new login shows the later-account guidance and failed code placeholder', async () => {
  const api = createApi();
  api.startClaudeAuthLogin.mockResolvedValueOnce({ ...loginFlow, state: 'failed', auth_url: null });
  const { view } = renderPool(api);
  fireEvent.press(view.getByLabelText('Claude 계정 추가'));

  expect(await view.findByText('2번째 이후 계정')).toBeTruthy();
  expect(view.getByText('다른 계정은 시크릿 창이나 별도 브라우저 프로필에서 열어야 구분됩니다.')).toBeTruthy();
  expect(view.getByPlaceholderText('새 인증 코드 붙여넣기 (code#state)')).toBeTruthy();
});

test('relogin title includes the target account email and uses a single-line focused input', async () => {
  const api = createApi();
  api.startClaudeAuthLogin.mockResolvedValueOnce({ ...loginFlow, account_id: 'one' });
  const { view } = renderPool(api);
  fireEvent.press(view.getByTestId('claude-account-relogin-one'));

  expect(await view.findByText('재로그인 (one@example.invalid)')).toBeTruthy();
  const input = view.getByLabelText('인증 코드');
  expect(input.props.multiline).toBeUndefined();
  fireEvent(input, 'focus');
  expect(StyleSheet.flatten(view.getByTestId('claude-login-code').props.style) ?? {}).toMatchObject({ borderColor: expect.any(String), backgroundColor: expect.any(String) });
});

test('reset weekdays are Korean, blocked five-hour quota shows its reset clock, and idle rows show confirmation timing', () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 9, 28, 12, 0));
  const resetAt = '2026-10-28T14:30:00.000Z';
  const sameDayObserved = new Date(2026, 9, 28, 8, 10).toISOString();
  const previousDayObserved = new Date(2026, 9, 27, 8, 10).toISOString();
  const list: ClaudeAccountList = {
    ...initial,
    accounts: [
      { ...account('blocked', 1), blocked: { scope: 'all', until: resetAt }, usage: {
        ...account('blocked', 1).usage,
        five_hour: { used_percent: 100, resets_at: resetAt },
      } },
      { ...account('idle-today', 2), auth_state: 'idle', usage: { five_hour: null, seven_day: null, fable_weekly: null }, observed_at: sameDayObserved },
      { ...account('idle-yesterday', 3), auth_state: 'idle', usage: { five_hour: null, seven_day: null, fable_weekly: null }, observed_at: previousDayObserved },
    ],
  };
  const { view } = renderPool(createApi(), list);

  expect(view.getAllByText(/^[일월화수목금토] /)).toHaveLength(2);
  expect(view.getAllByText(/\d{2}:\d{2} 해제/)).toHaveLength(2);
  expect(view.getByText('08:10 확인')).toBeTruthy();
  expect(view.getByText('어제 확인')).toBeTruthy();
  jest.useRealTimers();
});

test('single-account pools keep the legacy weekly summary and omit rank controls', () => {
  const one = { ...initial, accounts: [account('solo', 1)], pool: { ...initial.pool!, available_count: 1, total_count: 1 } };
  const view = render(<ClaudeAccountPoolSection nodeId="node-a" initialList={one} api={createApi()} />);
  expect(view.getByText('주간 잔여 87%')).toBeTruthy();
  expect(view.queryByText('1/1 가용')).toBeNull();
  expect(view.queryByTestId('claude-priority-up-solo')).toBeNull();
});

test('disabled accounts do not extend the enabled priority range', () => {
  const list = { ...initial, accounts: [...initial.accounts.slice(0, 2), account('off', 3, false)] };
  const view = render(<ClaudeAccountPoolSection nodeId="node-a" initialList={list} api={createApi()} />);
  expect(view.getByTestId('claude-priority-down-two').props.accessibilityState.disabled).toBe(true);
});
