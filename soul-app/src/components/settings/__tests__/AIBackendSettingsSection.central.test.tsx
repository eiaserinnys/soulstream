jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type {
  ClaudeAccount,
  ClaudeAccountList,
  ClaudeCentralSettings,
} from '../../../../../packages/soul-ui/src/lib/usage-summary';
import type { AppUsageSummarySnapshot } from '../../../api/usageEndpoints';
import { AIBackendSettingsSection } from '../AIBackendSettingsSection';
import type { NodeProviderSectionsApi } from '../NodeProviderSections';

const reset = '2026-10-28T12:00:00.000Z';

function account(id: string, priority: number | null, overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id,
    email: `${id}@example.invalid`,
    plan: 'Max 5x',
    enabled: true,
    priority,
    auth_state: 'ok',
    source: 'central',
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

function centralList(accounts: ClaudeAccount[]): ClaudeAccountList {
  return {
    mode: 'pool',
    accounts,
    pool: {
      available_count: accounts.length,
      total_count: accounts.length,
      best_weekly_remaining_percent: accounts.length ? 87 : null,
      best_weekly_resets_at: null,
      earliest_available_at: null,
    },
    fable_pool: null,
  };
}

const emptyNodeList: ClaudeAccountList = centralList([]);
const emptySummary: AppUsageSummarySnapshot = {
  generatedAt: '2026-10-28T09:10:00.000Z',
  collectedAt: '2026-10-28T09:10:00.000Z',
  nodes: [],
};

const settings: ClaudeCentralSettings = {
  default_receive: true,
  nodes: { 'node-a': true },
  effective: [{ node_id: 'node-a', receive: true, connected: true }],
};

function createApi(central: ClaudeAccountList) {
  const nodeApi = {
    getUsageSummary: jest.fn(async () => emptySummary),
    refreshUsageSummary: jest.fn(async () => emptySummary),
    getClaudeAuthStatus: jest.fn(async () => ({ has_token: false })),
    getClaudeProfile: jest.fn(async () => null),
    startClaudeAuth: jest.fn(async () => ({ authUrl: 'fixture' })),
    submitClaudeCode: jest.fn(async () => ({ ok: true } as Response)),
    deleteClaudeToken: jest.fn(async () => ({ ok: true } as Response)),
    getClaudeAuthAccounts: jest.fn(async () => emptyNodeList),
    patchClaudeAuthAccount: jest.fn(async () => emptyNodeList),
    deleteClaudeAuthAccount: jest.fn(async () => ({ deferred: false, accounts: [], pool: null })),
    startClaudeAuthLogin: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'url_ready', auth_url: 'fixture', expires_at: reset, error: null })),
    getClaudeAuthLogin: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'url_ready', auth_url: 'fixture', expires_at: reset, error: null })),
    submitClaudeAuthLoginCode: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'done', auth_url: null, expires_at: reset, error: null })),
    cancelClaudeAuthLogin: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'cancelled', auth_url: null, expires_at: reset, error: null })),
    getCentralClaudeAuthAccounts: jest.fn(async () => central),
    patchCentralClaudeAuthAccount: jest.fn(async () => central),
    deleteCentralClaudeAuthAccount: jest.fn(async () => ({ success: true })),
    startCentralClaudeAuthLogin: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'url_ready', auth_url: 'fixture', expires_at: reset, error: null })),
    getCentralClaudeAuthLogin: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'url_ready', auth_url: 'fixture', expires_at: reset, error: null })),
    submitCentralClaudeAuthLoginCode: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'done', auth_url: null, expires_at: reset, error: null })),
    cancelCentralClaudeAuthLogin: jest.fn(async () => ({ login_id: 'login-a', account_id: null, state: 'cancelled', auth_url: null, expires_at: reset, error: null })),
    getClaudeCentralSettings: jest.fn(async () => settings),
    putClaudeCentralReceive: jest.fn(async (_nodeId: string, receive: boolean) => ({ ...settings, nodes: { 'node-a': receive } })),
  };
  return nodeApi as unknown as jest.Mocked<NodeProviderSectionsApi> & typeof nodeApi;
}

function renderSection(api: jest.Mocked<NodeProviderSectionsApi> & ReturnType<typeof createApi>, mode: 'single' | 'orchestrator') {
  return render(<AIBackendSettingsSection flattened={false} serverUrl="https://review.invalid" mode={mode}
    currentNodeId="node-a" nodes={[{ nodeId: 'node-a' }, { nodeId: 'node-b' }]}
    loadingNodes={false} apiClient={api} />);
}

describe('AIBackendSettingsSection central pool zone', () => {
  test('shows the central pool zone above the node picker in orchestrator mode', async () => {
    const api = createApi(centralList([
      account('central-a', 1),
      account('central-b', 2, { enabled: false }),
    ]));
    const view = renderSection(api, 'orchestrator');

    await waitFor(() => expect(view.getByTestId('settings-section-central-pool')).toBeTruthy());
    await waitFor(() => expect(view.getByTestId('claude-account-row-central-a')).toBeTruthy());
    expect(view.getByText('중앙 풀')).toBeTruthy();
    expect(view.getByTestId('settings-section-backend-scope')).toBeTruthy();
    expect(api.getCentralClaudeAuthAccounts).toHaveBeenCalledTimes(1);

    const tree = JSON.stringify(view.toJSON());
    expect(tree.indexOf('settings-section-central-pool')).toBeLessThan(tree.indexOf('settings-section-backend-scope'));
    expect(tree.indexOf('claude-account-row-central-a')).toBeLessThan(tree.indexOf('settings-section-backend-scope'));
  });

  test('does not draw the central pool zone in single mode', async () => {
    const api = createApi(centralList([account('central-a', 1)]));
    const view = renderSection(api, 'single');

    await waitFor(() => expect(view.getByTestId('settings-section-backend-scope')).toBeTruthy());
    expect(view.getByText('node-a')).toBeTruthy();
    expect(view.queryByTestId('settings-section-central-pool')).toBeNull();
    expect(view.queryByText('중앙 풀')).toBeNull();
    expect(api.getCentralClaudeAuthAccounts).not.toHaveBeenCalled();
  });

  test('shows the zone loading frame until the central list arrives', async () => {
    const api = createApi(centralList([account('central-a', 1)]));
    api.getCentralClaudeAuthAccounts.mockImplementationOnce(() => new Promise<never>(() => {}));
    const view = renderSection(api, 'orchestrator');

    await waitFor(() => expect(view.getByTestId('central-pool-loading')).toBeTruthy());
    expect(view.queryByText('Claude 계정')).toBeNull();
  });

  test('shows the list failure in place and reads again through the retry button', async () => {
    const api = createApi(centralList([account('central-a', 1)]));
    api.getCentralClaudeAuthAccounts.mockRejectedValueOnce(new Error('offline'));
    const view = renderSection(api, 'orchestrator');

    await waitFor(() => expect(view.getByText('계정 목록을 갱신하지 못했습니다.')).toBeTruthy());
    fireEvent.press(view.getByLabelText('다시 시도'));

    await waitFor(() => expect(view.getByTestId('claude-account-row-central-a')).toBeTruthy());
    expect(api.getCentralClaudeAuthAccounts).toHaveBeenCalledTimes(2);
  });
});
