jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type {
  ClaudeAccount,
  ClaudeAccountList,
  ClaudeAuthLoginFlow,
  ClaudeCentralSettings,
} from '../../../../../packages/soul-ui/src/lib/usage-summary';
import {
  ClaudeAccountPoolSection,
  type ClaudeAccountPoolApi,
  type ClaudeCentralPoolApi,
} from '../ClaudeAccountPoolSection';
import type { ClaudeCentralSettingsApi } from '../ClaudeCentralReceiveRow';

const reset = '2026-10-28T12:00:00.000Z';

function account(id: string, priority: number | null, overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id,
    email: `${id}@example.invalid`,
    plan: 'Max 5x',
    enabled: true,
    priority,
    auth_state: 'ok',
    usage: {
      five_hour: { used_percent: 24, resets_at: reset },
      seven_day: { used_percent: 13, resets_at: reset },
      fable_weekly: { used_percent: 18, resets_at: reset },
    },
    observed_at: '2026-10-28T09:10:00.000Z',
    blocked: null,
    active_sessions: 0,
    ...overrides,
  };
}

function list(accounts: ClaudeAccount[], available = accounts.filter(entry => entry.enabled && entry.auth_state === 'ok').length): ClaudeAccountList {
  return {
    mode: 'pool',
    accounts,
    pool: {
      available_count: available,
      total_count: accounts.length,
      best_weekly_remaining_percent: 87,
      best_weekly_resets_at: null,
      earliest_available_at: null,
    },
    fable_pool: { available_count: available, total_count: accounts.length, best_weekly_remaining_percent: 82, best_weekly_resets_at: null, earliest_available_at: null },
  };
}

function flow(state: ClaudeAuthLoginFlow['state'], overrides: Partial<ClaudeAuthLoginFlow> = {}): ClaudeAuthLoginFlow {
  return {
    login_id: 'login-a',
    account_id: null,
    state,
    auth_url: state === 'url_ready' ? 'fixture' : null,
    expires_at: reset,
    error: null,
    ...overrides,
  };
}

function settings(receive: boolean): ClaudeCentralSettings {
  return {
    default_receive: true,
    nodes: { 'node-a': receive },
    effective: [{ node_id: 'node-a', receive, connected: true }],
  };
}

type FullApi = ClaudeAccountPoolApi & ClaudeCentralPoolApi & ClaudeCentralSettingsApi;

function createApi(initial: ClaudeAccountList) {
  let current = initial;
  let currentFlow = flow('url_ready');
  let currentSettings = settings(true);
  const api = {
    getClaudeAuthAccounts: jest.fn(async () => current),
    patchClaudeAuthAccount: jest.fn(async (_nodeId: string, accountId: string, patch: Partial<ClaudeAccount>) => {
      current = { ...current, accounts: current.accounts.map(entry => entry.id === accountId ? { ...entry, ...patch } : entry) };
      return current;
    }),
    deleteClaudeAuthAccount: jest.fn(async () => ({ deferred: false, accounts: current.accounts, pool: current.pool })),
    startClaudeAuthLogin: jest.fn(async () => currentFlow),
    getClaudeAuthLogin: jest.fn(async () => currentFlow),
    submitClaudeAuthLoginCode: jest.fn(async () => currentFlow),
    cancelClaudeAuthLogin: jest.fn(async () => currentFlow),
    getCentralClaudeAuthAccounts: jest.fn(async () => current),
    patchCentralClaudeAuthAccount: jest.fn(async (accountId: string, patch: { enabled?: boolean; priority?: number }) => {
      current = { ...current, accounts: current.accounts.map(entry => entry.id === accountId ? { ...entry, ...patch } : entry) };
      return current;
    }),
    deleteCentralClaudeAuthAccount: jest.fn(async (accountId: string) => {
      current = { ...current, accounts: current.accounts.filter(entry => entry.id !== accountId) };
      return { success: true };
    }),
    startCentralClaudeAuthLogin: jest.fn(async (accountId?: string) => {
      currentFlow = flow('url_ready', { account_id: accountId ?? null });
      return currentFlow;
    }),
    getCentralClaudeAuthLogin: jest.fn(async () => currentFlow),
    submitCentralClaudeAuthLoginCode: jest.fn(async () => {
      currentFlow = flow('verifying');
      return currentFlow;
    }),
    cancelCentralClaudeAuthLogin: jest.fn(async () => flow('cancelled')),
    getClaudeCentralSettings: jest.fn(async () => currentSettings),
    putClaudeCentralReceive: jest.fn(async (_nodeId: string, receive: boolean) => {
      currentSettings = settings(receive);
      return currentSettings;
    }),
  };
  return {
    api: api as unknown as jest.Mocked<FullApi>,
    current: () => current,
    setCurrent: (next: ClaudeAccountList) => { current = next; },
    setFlow: (next: ClaudeAuthLoginFlow) => { currentFlow = next; },
    settings: () => currentSettings,
  };
}

function renderCentral(harness: ReturnType<typeof createApi>, initial = harness.current()) {
  return render(<ClaudeAccountPoolSection central initialList={initial} api={harness.api} />);
}

function renderNode(
  harness: ReturnType<typeof createApi>,
  initial = harness.current(),
  extra: { nodeId?: string; centralSettingsApi?: ClaudeCentralSettingsApi } = {},
) {
  return render(<ClaudeAccountPoolSection nodeId={extra.nodeId ?? 'node-a'} initialList={initial}
    api={harness.api} centralSettingsApi={extra.centralSettingsApi} />);
}

describe('ClaudeAccountPoolSection central target', () => {
  test('sends enabled and priority changes to the central API without a null priority', async () => {
    const harness = createApi(list([account('a', null), account('b', null), account('c', null)]));
    const view = renderCentral(harness);

    fireEvent(view.getByTestId('claude-account-toggle-a'), 'valueChange', false);
    await waitFor(() => expect(harness.api.patchCentralClaudeAuthAccount).toHaveBeenCalledTimes(1));
    expect(harness.api.patchCentralClaudeAuthAccount).toHaveBeenNthCalledWith(1, 'a', { enabled: false });

    fireEvent.press(view.getByTestId('claude-priority-up-c'));
    await waitFor(() => expect(harness.api.patchCentralClaudeAuthAccount.mock.calls.length).toBeGreaterThan(1));
    for (const [, patch] of harness.api.patchCentralClaudeAuthAccount.mock.calls) {
      expect(patch.priority === undefined || typeof patch.priority === 'number').toBe(true);
      expect(patch.priority).not.toBeNull();
    }
    expect(harness.api.patchClaudeAuthAccount).not.toHaveBeenCalled();
    expect(harness.api.patchCentralClaudeAuthAccount.mock.calls.every(([id]) => ['a', 'b', 'c'].includes(id))).toBe(true);
  });

  test('deletes through the central API and rereads the central list without deferred wording', async () => {
    const harness = createApi(list([account('a', 1), account('b', 2)]));
    const view = renderCentral(harness);

    fireEvent.press(view.getByTestId('claude-account-delete-a'));
    fireEvent.press(view.getByTestId('claude-account-delete-confirm-a'));

    await waitFor(() => expect(harness.api.deleteCentralClaudeAuthAccount).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(view.getByText('Claude 계정을 삭제했습니다.')).toBeTruthy());
    expect(harness.api.getCentralClaudeAuthAccounts).toHaveBeenCalledTimes(1);
    expect(view.queryByText('현재 세션이 끝난 뒤 삭제합니다.')).toBeNull();
    expect(view.queryByTestId('claude-account-row-a')).toBeNull();
    expect(harness.api.deleteClaudeAuthAccount).not.toHaveBeenCalled();
  });

  test('starts, submits and completes a central login, then rereads the central list', async () => {
    const initial = list([account('a', 1)]);
    const harness = createApi(initial);
    const refreshed = list([account('a', 1), account('new', 2, { email: 'new@example.invalid' })]);
    const view = renderCentral(harness);

    fireEvent.press(view.getByTestId('claude-account-add'));
    await waitFor(() => expect(harness.api.startCentralClaudeAuthLogin).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(view.getByTestId('claude-login-flow')).toBeTruthy());
    expect(harness.api.startClaudeAuthLogin).not.toHaveBeenCalled();

    harness.api.submitCentralClaudeAuthLoginCode.mockImplementation(async () => {
      harness.setCurrent(refreshed);
      return flow('done');
    });
    fireEvent.changeText(view.getByTestId('claude-login-code'), 'central-code#state');
    fireEvent.press(view.getByTestId('claude-login-submit'));

    await waitFor(() => expect(harness.api.submitCentralClaudeAuthLoginCode).toHaveBeenCalledWith('login-a', 'central-code#state'));
    await waitFor(() => expect(view.getByText('Claude 계정이 연결되었습니다.')).toBeTruthy());
    await waitFor(() => expect(view.getByTestId('claude-account-row-new')).toBeTruthy());
    expect(harness.api.submitClaudeAuthLoginCode).not.toHaveBeenCalled();
    expect(harness.api.getCentralClaudeAuthAccounts).toHaveBeenCalledTimes(1);
  });

  test('draws only local accounts from a node list and keeps the node pool summary as served', () => {
    const nodeList = list([
      account('local-a', 1),
      account('local-b', 2),
      account('central-a', 1, { source: 'central', expires_at: reset, refreshed_at: null, relogin_reason: null }),
    ], 2);
    const harness = createApi(nodeList);
    const view = renderNode(harness);

    expect(view.getByText('2/3 가용 (주간 최대 잔여 87%)')).toBeTruthy();
    expect(view.getByTestId('claude-account-row-local-a')).toBeTruthy();
    expect(view.getByTestId('claude-account-row-local-b')).toBeTruthy();
    expect(view.queryByTestId('claude-account-row-central-a')).toBeNull();
    expect(view.queryByText('central-a@example.invalid')).toBeNull();
  });
});

describe('ClaudeAccountPoolSection central receive row', () => {
  test('shows the saved receive value and writes only that node to the central settings', async () => {
    const harness = createApi(list([account('local-a', 1)]));
    const view = renderNode(harness, harness.current(), { centralSettingsApi: harness.api });

    const toggle = view.getByTestId('claude-central-receive-switch');
    await waitFor(() => expect(toggle.props.value).toBe(true));

    fireEvent(toggle, 'valueChange', false);
    await waitFor(() => expect(harness.api.putClaudeCentralReceive).toHaveBeenCalledWith('node-a', false));
    await waitFor(() => expect(view.getByTestId('claude-central-receive-switch').props.value).toBe(false));
    // 저장이 끝나면 그 노드의 계정 목록을 다시 읽는다.
    expect(harness.api.getClaudeAuthAccounts).toHaveBeenCalledTimes(1);
    expect(harness.settings().effective[0]).toEqual({ node_id: 'node-a', receive: false, connected: true });
  });

  test('keeps the switch disabled in the requested position while the save is pending', async () => {
    const harness = createApi(list([account('local-a', 1)]));
    let resolvePut!: (value: ClaudeCentralSettings) => void;
    harness.api.putClaudeCentralReceive.mockImplementationOnce(() => new Promise<ClaudeCentralSettings>(resolve => { resolvePut = resolve; }));
    const view = renderNode(harness, harness.current(), { centralSettingsApi: harness.api });

    const toggle = view.getByTestId('claude-central-receive-switch');
    await waitFor(() => expect(toggle.props.value).toBe(true));
    fireEvent(toggle, 'valueChange', false);

    await waitFor(() => expect(view.getByTestId('claude-central-receive-switch').props.value).toBe(false));
    expect(view.getByTestId('claude-central-receive-switch').props.disabled).toBe(true);

    await act(async () => { resolvePut(settings(false)); });
    await waitFor(() => expect(view.getByTestId('claude-central-receive-switch').props.disabled).toBe(false));
    expect(view.getByTestId('claude-central-receive-switch').props.value).toBe(false);
  });

  test('goes back to the saved value and retries the same write after a failure', async () => {
    const harness = createApi(list([account('local-a', 1)]));
    harness.api.putClaudeCentralReceive.mockRejectedValueOnce(new Error('offline'));
    const view = renderNode(harness, harness.current(), { centralSettingsApi: harness.api });

    const toggle = view.getByTestId('claude-central-receive-switch');
    await waitFor(() => expect(toggle.props.value).toBe(true));
    fireEvent(toggle, 'valueChange', false);

    await waitFor(() => expect(view.getByText('계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.')).toBeTruthy());
    expect(view.getByTestId('claude-central-receive-switch').props.value).toBe(true);

    fireEvent.press(view.getByTestId('claude-central-receive-retry'));
    await waitFor(() => expect(harness.api.putClaudeCentralReceive).toHaveBeenCalledTimes(2));
    expect(harness.api.putClaudeCentralReceive).toHaveBeenLastCalledWith('node-a', false);
    await waitFor(() => expect(view.getByTestId('claude-central-receive-switch').props.value).toBe(false));
  });

  test('replaces the switch with a failure notice and a retry when the settings cannot be read', async () => {
    const harness = createApi(list([account('local-a', 1)]));
    harness.api.getClaudeCentralSettings.mockRejectedValueOnce(new Error('offline'));
    const view = renderNode(harness, harness.current(), { centralSettingsApi: harness.api });

    await waitFor(() => expect(view.getByText('계정 목록을 갱신하지 못했습니다.')).toBeTruthy());
    expect(view.queryByTestId('claude-central-receive-switch')).toBeNull();

    fireEvent.press(view.getByTestId('claude-central-receive-retry'));
    await waitFor(() => expect(view.getByTestId('claude-central-receive-switch')).toBeTruthy());
    expect(view.getByTestId('claude-central-receive-switch').props.value).toBe(true);
  });

  test('does not draw the receive row without a settings api or on the central target', () => {
    const harness = createApi(list([account('local-a', 1)]));
    const nodeView = renderNode(harness);
    expect(nodeView.queryByTestId('claude-central-receive')).toBeNull();
    nodeView.unmount();

    const centralView = renderCentral(harness);
    expect(centralView.queryByTestId('claude-central-receive')).toBeNull();
  });
});
