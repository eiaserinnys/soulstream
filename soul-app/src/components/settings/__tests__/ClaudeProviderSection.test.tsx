import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
}));

import * as WebBrowser from 'expo-web-browser';
import type {
  ClaudeAccountList,
  UsageSummaryProvider,
  UsageSummaryQuota,
} from '../../../../../packages/soul-ui/src/lib/usage-summary';
import type { AppUsageSummaryProvider } from '../../../api/usageEndpoints';
import { ClaudeProviderSection, type ClaudeProviderApi } from '../ClaudeProviderSection';

const NOW = 1_800_000_000;

function quota(id: string, label: string, window: string, remainingPercent: number, model: string | null = null): UsageSummaryQuota {
  return { id, label, window, model, remainingPercent, resetAt: NOW + 3 * 60 * 60, purpose: 'execution' };
}

const claudeSummaryProvider: AppUsageSummaryProvider = {
  status: 'auto',
  weeklyRemainingPercent: 87,
  weeklyResetAt: NOW + 4 * 24 * 60 * 60,
  shortRemainingPercent: 76,
  shortResetAt: NOW + 3 * 60 * 60,
  quotas: [
    quota('claude:5h', '5시간', '5h', 76),
    quota('claude:7d', '7일', '7d', 87),
    quota('claude:weekly_scoped:fable', 'Fable', '7d', 82, 'Fable'),
  ],
};

const legacyList: ClaudeAccountList = {
  mode: 'legacy',
  accounts: [],
  pool: null,
  fable_pool: null,
};

const poolList: ClaudeAccountList = {
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

function createApi(): jest.Mocked<ClaudeProviderApi> {
  return {
    getClaudeAuthAccounts: jest.fn().mockResolvedValue(legacyList),
    patchClaudeAuthAccount: jest.fn().mockResolvedValue(legacyList),
    deleteClaudeAuthAccount: jest.fn().mockResolvedValue({ deferred: false, accounts: [], pool: null }),
    startClaudeAuthLogin: jest.fn().mockResolvedValue({
      login_id: 'review-login', account_id: null, state: 'url_ready', auth_url: 'fixture',
      expires_at: '2026-10-28T12:00:00.000Z', error: null,
    }),
    getClaudeAuthLogin: jest.fn().mockResolvedValue({
      login_id: 'review-login', account_id: null, state: 'url_ready', auth_url: 'fixture',
      expires_at: '2026-10-28T12:00:00.000Z', error: null,
    }),
    submitClaudeAuthLoginCode: jest.fn().mockResolvedValue({
      login_id: 'review-login', account_id: null, state: 'verifying', auth_url: null,
      expires_at: '2026-10-28T12:00:00.000Z', error: null,
    }),
    cancelClaudeAuthLogin: jest.fn().mockResolvedValue({
      login_id: 'review-login', account_id: null, state: 'cancelled', auth_url: null,
      expires_at: '2026-10-28T12:00:00.000Z', error: null,
    }),
    getClaudeAuthStatus: jest.fn().mockResolvedValue({ has_token: false }),
    getClaudeProfile: jest.fn().mockResolvedValue(null),
    startClaudeAuth: jest.fn(),
    submitClaudeCode: jest.fn(),
    deleteClaudeToken: jest.fn(),
  } as unknown as jest.Mocked<ClaudeProviderApi>;
}

const onTokenDeleted = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (WebBrowser.openBrowserAsync as jest.Mock)
    .mockReset()
    .mockResolvedValue({ type: 'cancel' });
});

function renderProvider(api: jest.Mocked<ClaudeProviderApi>, reloadKey = 0) {
  return render(
    <ClaudeProviderSection
      nodeId="node-x"
      api={api}
      summaryProvider={claudeSummaryProvider}
      loadingSummary={false}
      reloadKey={reloadKey}
      onTokenDeleted={onTokenDeleted}
    />,
  );
}

test('legacy mode keeps the existing login action and Claude account details', async () => {
  const api = createApi();
  api.getClaudeAuthStatus.mockResolvedValue({ has_token: true });
  api.getClaudeProfile.mockResolvedValue({ email: 'user@example.com', display_name: 'User', has_claude_max: true });
  const screen = renderProvider(api);

  expect(await screen.findByTestId('claude-login-action')).toBeTruthy();
  expect(await screen.findByText('user@example.com')).toBeTruthy();
  expect(screen.getByText('Claude Max')).toBeTruthy();
  expect(screen.queryByLabelText('Claude 계정 추가')).toBeNull();
  expect(screen.queryByTestId('claude-account-pool-section')).toBeNull();
  expect(api.getClaudeAuthStatus).toHaveBeenCalledWith('node-x');
  expect(api.getClaudeProfile).toHaveBeenCalledWith('node-x');
});

test('account list failure falls back to the legacy panel instead of a permanent spinner', async () => {
  const api = createApi();
  api.getClaudeAuthAccounts.mockRejectedValueOnce(new Error('offline'));
  const screen = renderProvider(api);

  expect(await screen.findByTestId('claude-login-action')).toBeTruthy();
  expect(screen.getByText('미인증')).toBeTruthy();
  expect(screen.queryByTestId('provider-row-claude-loading')).toBeNull();
});

test('legacy login opens the provider OAuth URL and submits the authorization code', async () => {
  const api = createApi();
  api.startClaudeAuth.mockResolvedValueOnce({ authUrl: 'https://claude.ai/oauth/start?node=node-x' });
  api.submitClaudeCode.mockResolvedValueOnce({ ok: true } as unknown as Response);
  api.getClaudeAuthStatus
    .mockResolvedValueOnce({ has_token: false })
    .mockResolvedValueOnce({ has_token: true });
  const screen = renderProvider(api);

  fireEvent.press(await screen.findByTestId('claude-login-action'));
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://claude.ai/oauth/start?node=node-x'));

  expect(await screen.findByTestId('claude-code-input')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('인증 코드'), ' code ');
  await act(async () => {
    fireEvent.press(screen.getByTestId('claude-code-confirm'));
  });

  await waitFor(() => expect(api.submitClaudeCode).toHaveBeenCalledWith('node-x', 'code'));
  expect(api.getClaudeAuthStatus).toHaveBeenCalledTimes(2);
});

test('legacy token deletion stays behind the destructive confirmation', async () => {
  const api = createApi();
  api.getClaudeAuthStatus.mockResolvedValueOnce({ has_token: true });
  api.deleteClaudeToken.mockResolvedValueOnce({ ok: true } as unknown as Response);
  let buttons: any[] = [];
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, actions) => {
    buttons = actions ?? [];
  });
  const screen = renderProvider(api);

  fireEvent.press(await screen.findByTestId('claude-delete-action'));
  const destructive = buttons.find((button) => button.style === 'destructive');
  expect(destructive).toBeTruthy();
  await act(async () => {
    await destructive.onPress();
  });

  expect(api.deleteClaudeToken).toHaveBeenCalledWith('node-x');
  expect(onTokenDeleted).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});

test('icon actions keep the 48pt hit frame without a fixed height', async () => {
  const api = createApi();
  api.getClaudeAuthStatus.mockResolvedValue({ has_token: true });
  const screen = renderProvider(api);

  const action = await screen.findByTestId('claude-login-action');
  const style = StyleSheet.flatten(action.props.style);
  expect(style.minHeight).toBeGreaterThanOrEqual(48);
  expect(style).not.toHaveProperty('height');
});

test('pool mode starts collapsed, shows the summary gauge, and expands into the account list', async () => {
  const api = createApi();
  api.getClaudeAuthAccounts.mockResolvedValue(poolList);
  api.startClaudeAuthLogin.mockResolvedValue({
    login_id: 'review-login', account_id: null, state: 'url_ready', auth_url: 'fixture',
    expires_at: '2026-10-28T12:00:00.000Z', error: null,
  });
  const screen = renderProvider(api);

  expect(await screen.findByText('계정 3')).toBeTruthy();
  expect(screen.getByText('2/3 가용 (주간 최대 잔여 87%)')).toBeTruthy();
  expect(screen.queryByTestId('claude-account-pool-section')).toBeNull();
  expect(screen.getByTestId('provider-quota-claude-0')).toBeTruthy();
  expect(screen.getByTestId('provider-quota-claude-1')).toBeTruthy();
  expect(screen.getByTestId('provider-quota-claude-2')).toBeTruthy();

  fireEvent.press(screen.getByTestId('claude-provider-header'));

  expect(await screen.findByTestId('claude-account-pool-section')).toBeTruthy();
  expect(screen.getAllByTestId(/^claude-account-row-/)).toHaveLength(3);
  expect(screen.queryByTestId('provider-quota-claude-0')).toBeNull();

  fireEvent.press(screen.getByTestId('claude-account-add'));
  await waitFor(() => expect(api.startClaudeAuthLogin).toHaveBeenCalledWith('node-x', undefined));
  expect(await screen.findByTestId('claude-login-flow')).toBeTruthy();

  fireEvent.press(screen.getByTestId('claude-provider-header'));
  await waitFor(() => expect(screen.queryByTestId('claude-account-pool-section')).toBeNull());
  expect(screen.getByTestId('provider-quota-claude-0')).toBeTruthy();
});

test('a node level refresh reloads the Claude account list', async () => {
  const api = createApi();
  api.getClaudeAuthAccounts.mockResolvedValue(poolList);
  const screen = renderProvider(api, 0);

  await waitFor(() => expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(1));
  screen.rerender(
    <ClaudeProviderSection
      nodeId="node-x"
      api={api}
      summaryProvider={claudeSummaryProvider}
      loadingSummary={false}
      reloadKey={1}
      onTokenDeleted={onTokenDeleted}
    />,
  );
  await waitFor(() => expect(api.getClaudeAuthAccounts).toHaveBeenCalledTimes(2));
});

test('summary load shows progress in the Claude row and gauge area', async () => {
  const api = createApi();
  const screen = render(
    <ClaudeProviderSection
      nodeId="node-x"
      api={api}
      summaryProvider={null}
      loadingSummary
      reloadKey={0}
      onTokenDeleted={onTokenDeleted}
    />,
  );

  await waitFor(() => expect(screen.getByTestId('claude-provider-loading')).toBeTruthy());
  expect(screen.getByTestId('claude-gauge-loading')).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-claude-0')).toBeNull();
});
