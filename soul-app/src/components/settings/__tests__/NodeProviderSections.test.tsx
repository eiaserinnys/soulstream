import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
}));

import type {
  ClaudeAccountList,
  UsageSummaryProvider,
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from '../../../../../packages/soul-ui/src/lib/usage-summary';
import type { AppUsageSummarySnapshot } from '../../../api/usageEndpoints';
import { NodeProviderSections, type NodeProviderSectionsApi } from '../NodeProviderSections';
import { SettingsSurface } from '../SettingsSurface';
import { SettingsWorkspaceContext } from '../SettingsWorkspaceContext';

const NOW = 1_800_000_000;

function quota(
  id: string,
  label: string,
  window: string,
  remainingPercent: number,
  resetAt = NOW + 3 * 60 * 60,
  model: string | null = null,
): UsageSummaryQuota {
  return { id, label, window, model, remainingPercent, resetAt, purpose: 'execution' };
}

function provider(
  status: UsageSummaryProvider['status'],
  quotas: UsageSummaryQuota[] = [],
): UsageSummaryProvider {
  return {
    status,
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    shortRemainingPercent: null,
    shortResetAt: null,
    quotas,
  };
}

const claudeProvider = () => provider('auto', [
  quota('claude:5h', '5시간', '5h', 76),
  quota('claude:7d', '7일', '7d', 87, NOW + 4 * 24 * 60 * 60),
  quota('claude:weekly_scoped:fable', 'Fable', '7d', 82, NOW + 4 * 24 * 60 * 60, 'Fable'),
]);

function summaryFor(
  nodeId: string,
  providers: Partial<Record<'claude' | 'opencode_go' | 'codex' | 'antigravity', UsageSummaryProvider | null>>,
  options: { fetchedAt?: string | null; stale?: boolean; staleSince?: string | null } = {},
): AppUsageSummarySnapshot {
  return {
    generatedAt: '2026-11-07T05:22:00.000Z',
    collectedAt: '2026-11-07T05:21:00.000Z',
    nodes: [{
      nodeId,
      fetchedAt: options.fetchedAt === undefined ? '2026-11-07T05:20:00.000Z' : options.fetchedAt,
      stale: options.stale ?? false,
      staleSince: options.staleSince ?? null,
      providers: {
        claude: providers.claude ?? null,
        opencode_go: providers.opencode_go ?? null,
        codex: providers.codex ?? null,
        antigravity: providers.antigravity ?? null,
      },
    }],
  };
}

const legacyClaudeList: ClaudeAccountList = {
  mode: 'legacy',
  accounts: [],
  pool: null,
  fable_pool: null,
};

const poolClaudeList: ClaudeAccountList = {
  mode: 'pool',
  accounts: [
    {
      id: 'review-one', email: 'primary@example.invalid', plan: 'Max 20x', enabled: true, priority: 1,
      auth_state: 'ok', usage: {
        five_hour: { used_percent: 24, resets_at: '2026-10-28T12:00:00.000Z' },
        seven_day: { used_percent: 13, resets_at: '2026-10-29T12:00:00.000Z' },
        fable_weekly: { used_percent: 18, resets_at: '2026-10-29T12:00:00.000Z' },
      }, observed_at: '2026-10-28T09:10:00.000Z', blocked: null, active_sessions: 2,
    },
    {
      id: 'review-two', email: 'backup@example.invalid', plan: 'Max 5x', enabled: true, priority: 2,
      auth_state: 'ok', usage: {
        five_hour: { used_percent: 100, resets_at: '2026-10-28T14:30:00.000Z' },
        seven_day: { used_percent: 68, resets_at: '2026-10-30T12:00:00.000Z' },
        fable_weekly: { used_percent: 82, resets_at: '2026-10-30T12:00:00.000Z' },
      }, observed_at: '2026-10-28T09:08:00.000Z',
      blocked: { until: '2026-10-28T14:30:00.000Z', scope: 'all' }, active_sessions: 0,
    },
    {
      id: 'review-three', email: 'reserve@example.invalid', plan: 'Pro', enabled: true, priority: 3,
      auth_state: 'idle', usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: '2026-10-27T23:10:00.000Z', blocked: null, active_sessions: 0,
    },
  ],
  pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 87, best_weekly_resets_at: '2026-10-30T12:00:00.000Z', earliest_available_at: '2026-10-28T14:30:00.000Z' },
  fable_pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 82, best_weekly_resets_at: '2026-10-30T12:00:00.000Z', earliest_available_at: '2026-10-28T14:30:00.000Z' },
};

function createApi(): jest.Mocked<NodeProviderSectionsApi> {
  return {
    getUsageSummary: jest.fn().mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() })),
    refreshUsageSummary: jest.fn().mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() })),
    getClaudeAuthAccounts: jest.fn().mockResolvedValue(legacyClaudeList),
    patchClaudeAuthAccount: jest.fn().mockResolvedValue(legacyClaudeList),
    deleteClaudeAuthAccount: jest.fn().mockResolvedValue({ deferred: false, accounts: [], pool: null }),
    startClaudeAuthLogin: jest.fn(),
    getClaudeAuthLogin: jest.fn(),
    submitClaudeAuthLoginCode: jest.fn(),
    cancelClaudeAuthLogin: jest.fn(),
    getClaudeAuthStatus: jest.fn().mockResolvedValue({ has_token: false }),
    getClaudeProfile: jest.fn().mockResolvedValue(null),
    startClaudeAuth: jest.fn(),
    submitClaudeCode: jest.fn(),
    deleteClaudeToken: jest.fn(),
  } as unknown as jest.Mocked<NodeProviderSectionsApi>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders one provider-neutral row per configured provider in a fixed order', async () => {
  const api = createApi();
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', {
    claude: claudeProvider(),
    opencode_go: provider('auto', [
      quota('opencode_go:rolling', '5시간', '5h', 98),
      quota('opencode_go:weekly', '7일', '7d', 82, NOW + 4 * 24 * 60 * 60),
      quota('opencode_go:monthly', '월', 'monthly', 91, NOW + 20 * 24 * 60 * 60),
    ]),
    codex: provider('auto', [quota('codex:7d', '7일', '168h', 58, NOW + 4 * 24 * 60 * 60)]),
    antigravity: provider('not_configured'),
  }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  expect(await screen.findByTestId('provider-row-claude')).toBeTruthy();
  expect(screen.getByTestId('provider-row-opencode_go')).toBeTruthy();
  expect(screen.getByTestId('provider-row-codex')).toBeTruthy();
  expect(screen.getByTestId('provider-row-antigravity')).toBeTruthy();
  expect(screen.getAllByTestId(/^provider-row-/).map(row => row.props.testID)).toEqual([
    'provider-row-claude',
    'provider-row-opencode_go',
    'provider-row-codex',
    'provider-row-antigravity',
  ]);

  expect(within(screen.getByTestId('provider-quota-claude-0')).getByText('5시간')).toBeTruthy();
  expect(within(screen.getByTestId('provider-quota-claude-0')).getByText('24%')).toBeTruthy();
  expect(within(screen.getByTestId('provider-quota-claude-1')).getByText('7일')).toBeTruthy();
  expect(within(screen.getByTestId('provider-quota-claude-2')).getByText('Fable')).toBeTruthy();

  expect(within(screen.getByTestId('provider-quota-opencode_go-2')).getByText('월간')).toBeTruthy();
  expect(within(screen.getByTestId('provider-quota-opencode_go-2')).queryByText('월')).toBeNull();
  expect(within(screen.getByTestId('provider-quota-opencode_go-0')).getByText('2%')).toBeTruthy();

  expect(within(screen.getByTestId('provider-quota-codex-1')).getByText('7일')).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-codex-bar-0')).toBeNull();
  expect(screen.getByTestId('provider-quota-codex-bar-1')).toBeTruthy();

  expect(within(screen.getByTestId('provider-row-antigravity')).getByText('미설정')).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-antigravity-0')).toBeNull();
});

test('error and empty providers keep one-line rows without gauges', async () => {
  const api = createApi();
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', {
    claude: claudeProvider(),
    codex: provider('error'),
    antigravity: provider('auto'),
  }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  const codex = await screen.findByTestId('provider-row-codex');
  expect(within(codex).getByText('조회 오류')).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-codex-0')).toBeNull();
  expect(within(screen.getByTestId('provider-row-antigravity')).queryByText('미설정')).toBeNull();
  expect(screen.queryByTestId('provider-quota-antigravity-0')).toBeNull();
});

test('Claude stays visible while other rows wait for the summary and the node update line renders', async () => {
  let resolveSummary!: (value: AppUsageSummarySnapshot) => void;
  const api = createApi();
  api.getUsageSummary.mockReturnValue(new Promise(resolve => { resolveSummary = resolve; }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  expect(screen.getByTestId('provider-row-claude')).toBeTruthy();
  expect(screen.queryByTestId('provider-row-codex')).toBeNull();
  expect(screen.getByTestId('provider-panel-updated').props.children).toBe('갱신 대기 중');

  await act(async () => {
    resolveSummary(summaryFor('node-a', { claude: claudeProvider(), codex: provider('auto') }));
  });
  expect(await screen.findByTestId('provider-row-codex')).toBeTruthy();
});

test('stale nodes show the collection-delay badge and the update meta uses local HH:MM', async () => {
  const api = createApi();
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() }, {
    fetchedAt: '2026-11-07T05:20:00.000Z',
    stale: true,
    staleSince: '2026-11-07T04:05:00.000Z',
  }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  const meta = await screen.findByTestId('provider-panel-updated');
  expect(meta.props.children).toMatch(/^수집 지연 · \d{2}:\d{2}$/);
});

test('refresh posts once, applies the returned snapshot, and reloads Claude accounts', async () => {
  const api = createApi();
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', {
    claude: claudeProvider(),
    codex: provider('auto', [quota('codex:7d', '7일', '168h', 58)]),
  }));
  api.refreshUsageSummary.mockResolvedValue(summaryFor('node-a', {
    claude: claudeProvider(),
    codex: provider('auto', [quota('codex:7d', '7일', '168h', 10)]),
  }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  expect(await screen.findByText('42%')).toBeTruthy();
  expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByTestId('provider-panel-refresh'));

  await waitFor(() => expect(api.refreshUsageSummary).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('90%')).toBeTruthy();
  expect(screen.queryByText('42%')).toBeNull();
  await waitFor(() => expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(2));
});

test('refresh failure keeps the previous gauges and shows a short failure mark', async () => {
  const api = createApi();
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', {
    claude: claudeProvider(),
    codex: provider('auto', [quota('codex:7d', '7일', '168h', 58)]),
  }));
  api.refreshUsageSummary.mockRejectedValue(new Error('offline'));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  expect(await screen.findByText('42%')).toBeTruthy();
  fireEvent.press(screen.getByTestId('provider-panel-refresh'));

  expect(await screen.findByTestId('provider-panel-refresh-error')).toBeTruthy();
  expect(screen.getByText('새로고침 실패')).toBeTruthy();
  expect(screen.getByText('42%')).toBeTruthy();
});

test('an older node summary that resolves late is discarded', async () => {
  let resolveA!: (value: AppUsageSummarySnapshot) => void;
  let resolveB!: (value: AppUsageSummarySnapshot) => void;
  const api = createApi();
  api.getUsageSummary
    .mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { resolveB = resolve; }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);
  screen.rerender(<NodeProviderSections nodeId="node-b" serverUrl="https://soul.test" apiClient={api} />);

  await act(async () => {
    resolveB(summaryFor('node-b', {
      claude: claudeProvider(),
      codex: provider('auto', [quota('codex:7d', '7일', '168h', 20)]),
    }));
  });
  expect(await screen.findByText('80%')).toBeTruthy();

  await act(async () => {
    resolveA(summaryFor('node-a', {
      claude: claudeProvider(),
      codex: provider('auto', [quota('codex:7d', '7일', '168h', 60)]),
    }));
  });
  expect(screen.queryByText('40%')).toBeNull();
  expect(screen.getByText('80%')).toBeTruthy();
});

test('the Claude row expands to the account panel without toggling on inner controls', async () => {
  const api = createApi();
  api.getClaudeAuthAccounts.mockResolvedValue(poolClaudeList);
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  await waitFor(() => expect(api.getClaudeAuthAccounts).toHaveBeenCalledWith('node-a'));
  expect(await screen.findByText('계정 3')).toBeTruthy();
  expect(screen.queryByTestId('claude-account-pool-section')).toBeNull();
  expect(screen.getByTestId('provider-quota-claude-0')).toBeTruthy();

  fireEvent.press(screen.getByTestId('claude-provider-header'));
  expect(await screen.findByTestId('claude-account-pool-section')).toBeTruthy();
  expect(screen.getAllByTestId(/^claude-account-row-/)).toHaveLength(3);
  expect(screen.queryByTestId('provider-quota-claude-0')).toBeNull();
  expect(screen.getByTestId('claude-account-add')).toBeTruthy();

  fireEvent(screen.getByTestId('claude-account-toggle-review-one'), 'valueChange', false);
  await waitFor(() => expect(api.patchClaudeAuthAccount).toHaveBeenCalledWith('node-a', 'review-one', { enabled: false }));
  expect(screen.getByTestId('claude-account-pool-section')).toBeTruthy();

  fireEvent.press(screen.getByTestId('claude-provider-header'));
  await waitFor(() => expect(screen.queryByTestId('claude-account-pool-section')).toBeNull());
  expect(screen.getByTestId('provider-quota-claude-0')).toBeTruthy();
});

test('refreshing keeps an expanded pool panel and applies the fetched accounts without remounting', async () => {
  const api = createApi();
  api.getClaudeAuthAccounts
    .mockResolvedValueOnce(poolClaudeList)
    .mockResolvedValueOnce({
      ...poolClaudeList,
      accounts: poolClaudeList.accounts.map(account => account.id === 'review-one'
        ? { ...account, email: 'updated@example.invalid' }
        : account),
    });
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() }));
  api.refreshUsageSummary.mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() }));
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />);

  await waitFor(() => expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(1));
  fireEvent.press(await screen.findByTestId('claude-provider-header'));
  expect(await screen.findByTestId('claude-account-row-review-one')).toBeTruthy();

  fireEvent.press(screen.getByTestId('provider-panel-refresh'));

  await waitFor(() => expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('updated@example.invalid')).toBeTruthy();
  expect(screen.getByTestId('claude-account-pool-section')).toBeTruthy();
});

test('workspace keeps the provider list in one full-width surface', async () => {
  const api = createApi();
  api.getUsageSummary.mockResolvedValue(summaryFor('node-a', { claude: claudeProvider() }));
  const workspace = {
    category: 'backends' as const,
    wide: true,
    columns: true,
    jobs: { kind: 'list' as const }, setJobs: jest.fn(),
    persistent: { kind: 'list' as const }, setPersistent: jest.fn(),
    register: jest.fn(), changeConnection: (action: () => void) => action(),
    select: jest.fn(), guard: (_id: unknown, action: () => void) => action(),
  };
  const screen = render(<SettingsWorkspaceContext.Provider value={workspace as never}>
    <NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" apiClient={api} />
  </SettingsWorkspaceContext.Provider>);

  await screen.findByTestId('provider-row-claude');
  const surfaces = screen.UNSAFE_getAllByType(SettingsSurface);
  expect(surfaces).toHaveLength(1);
  expect(StyleSheet.flatten(surfaces[0]!.props.style).width).toBe('100%');
  expect(screen.queryByText('Claude 사용량')).toBeNull();
  expect(screen.queryByTestId('claude-usage-action')).toBeNull();
});
