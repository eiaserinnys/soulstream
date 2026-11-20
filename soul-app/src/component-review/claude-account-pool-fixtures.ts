import type { ClaudeAccount, ClaudeAccountList, ClaudeAuthLoginFlow, ClaudeCentralSettings } from '../../../packages/soul-ui/src/lib/usage-summary';
import type { NodeProviderSectionsApi } from '../components/settings/NodeProviderSections';
import { reviewUsageSummary } from './usage-summary-fixtures';

const reviewNowSeconds = Math.floor(Date.now() / 1000);
const reviewIsoIn = (seconds: number) => new Date(seconds * 1000).toISOString();
const reviewResetSoon = reviewIsoIn(reviewNowSeconds + 3 * 60 * 60);
const reviewResetHalf = reviewIsoIn(reviewNowSeconds + Math.round(3.5 * 24 * 60 * 60));
const reviewResetSixty = reviewIsoIn(reviewNowSeconds + Math.round(2.8 * 24 * 60 * 60));

export const claudePoolReviewList: ClaudeAccountList = {
  mode: 'pool',
  accounts: [
    {
      id: 'review-one', email: 'primary@example.invalid', plan: 'Max 20x', enabled: true, priority: 1,
      auth_state: 'ok', usage: {
        five_hour: { used_percent: 24, resets_at: reviewResetSoon },
        // 빨리 씀: 지난 50%, 사용 72%. 여유: 지난 60%, 사용 20%.
        seven_day: { used_percent: 72, resets_at: reviewResetHalf },
        fable_weekly: { used_percent: 20, resets_at: reviewResetSixty },
      }, observed_at: '2026-10-28T09:10:00.000Z', blocked: null, active_sessions: 2,
    },
    {
      id: 'review-two', email: 'backup@example.invalid', plan: 'Max 5x', enabled: true, priority: 2,
      auth_state: 'ok', usage: {
        five_hour: { used_percent: 100, resets_at: reviewResetSoon },
        // 맞춤: 지난 50%, 사용 48%. 리셋 모름: 칸막이만 남고 커서가 없다.
        seven_day: { used_percent: 48, resets_at: reviewResetHalf },
        fable_weekly: { used_percent: 46, resets_at: null },
      }, observed_at: '2026-10-28T09:08:00.000Z',
      blocked: { until: reviewResetSoon, scope: 'all' }, active_sessions: 0,
    },
    {
      id: 'review-three', email: 'reserve@example.invalid', plan: 'Pro', enabled: true, priority: 3,
      auth_state: 'idle', usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: '2026-10-27T23:10:00.000Z', blocked: null, active_sessions: 0,
    },
    {
      id: 'review-old', email: 'expired@example.invalid', plan: 'Pro', enabled: false, priority: null,
      auth_state: 'needs_relogin', usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: '2026-10-26T23:10:00.000Z', blocked: null, active_sessions: 0,
    },
  ],
  pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 87, best_weekly_resets_at: '2026-10-30T12:00:00.000Z', earliest_available_at: '2026-10-28T14:30:00.000Z' },
  fable_pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 82, best_weekly_resets_at: '2026-10-30T12:00:00.000Z', earliest_available_at: '2026-10-28T14:30:00.000Z' },
};

// Provider panel capture uses the three accounts the design calls out: a normal
// first-priority account, a 5-hour-blocked account, and an unmeasured idle one.
// ReviewClaudePoolPas keeps the four-account list above.
export const providerPanelClaudeReviewList: ClaudeAccountList = {
  ...claudePoolReviewList,
  accounts: claudePoolReviewList.accounts.filter(account => account.id !== 'review-old'),
  pool: { ...claudePoolReviewList.pool!, available_count: 2, total_count: 3 },
  fable_pool: { ...claudePoolReviewList.fable_pool!, available_count: 2, total_count: 3 },
};

const centralReviewAccounts: ClaudeAccount[] = [
  {
    id: '3f5c2f5e-9f43-4c61-9d0e-0c2a4c8b1a01',
    email: 'seosoyoung.workspace+central-primary@example.invalid',
    plan: 'Max 20x', enabled: true, priority: 1, auth_state: 'ok', source: 'central',
    usage: {
      five_hour: { used_percent: 18, resets_at: reviewResetSoon },
      seven_day: { used_percent: 64, resets_at: reviewResetHalf },
      fable_weekly: { used_percent: 26, resets_at: reviewResetSixty },
    },
    observed_at: '2026-10-28T09:10:00.000Z', blocked: null, active_sessions: 0,
    expires_at: reviewIsoIn(reviewNowSeconds + 60 * 60), refreshed_at: '2026-10-28T09:00:00.000Z', relogin_reason: null,
  },
  {
    id: '8b1e46d2-2a55-4f0b-b0a1-5c6f7d9e4b02',
    email: 'central-backup@example.invalid',
    plan: 'Max 5x', enabled: false, priority: 2, auth_state: 'ok', source: 'central',
    usage: {
      five_hour: { used_percent: 100, resets_at: reviewResetSoon },
      seven_day: { used_percent: 48, resets_at: reviewResetHalf },
      fable_weekly: { used_percent: 46, resets_at: reviewResetSixty },
    },
    observed_at: '2026-10-28T09:08:00.000Z', blocked: null, active_sessions: 0,
    expires_at: reviewIsoIn(reviewNowSeconds + 30 * 60), refreshed_at: '2026-10-28T08:58:00.000Z', relogin_reason: null,
  },
  {
    id: 'c47a0d19-6b3e-4a82-8f3d-1e9b2c0a7d03',
    email: 'central-reserve@example.invalid',
    plan: 'Pro', enabled: true, priority: 3, auth_state: 'needs_relogin', source: 'central',
    usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: null, blocked: null, active_sessions: 0,
    expires_at: null, refreshed_at: null, relogin_reason: 'refresh_failed',
  },
];

function centralReviewList(accounts: ClaudeAccount[], available = accounts.filter(entry => entry.enabled && entry.auth_state === 'ok').length): ClaudeAccountList {
  return {
    mode: 'pool',
    accounts,
    pool: {
      available_count: available,
      total_count: accounts.length,
      best_weekly_remaining_percent: accounts.length ? 87 : null,
      best_weekly_resets_at: accounts.length ? reviewResetHalf : null,
      earliest_available_at: null,
    },
    fable_pool: null,
  };
}

function reviewCentralSettings(receive: boolean): ClaudeCentralSettings {
  return {
    default_receive: true,
    nodes: { 'node-a': receive },
    effective: [
      { node_id: 'node-a', receive, connected: true },
      { node_id: 'node-b', receive: true, connected: true },
    ],
  };
}

function receiveSettingsState(state: string | null | undefined): boolean | null {
  if (state === 'receive-on' || state === 'receive-pending' || state === 'receive-failure') return true;
  if (state === 'receive-off') return false;
  return null;
}

export function createClaudePoolReviewApi(state?: string | null): NodeProviderSectionsApi {
  const legacy = state === 'legacy' || state === 'legacy-stale';
  let current: ClaudeAccountList = legacy
    ? { mode: 'legacy', accounts: [], pool: null, fable_pool: null }
    : providerPanelClaudeReviewList;
  let flow: ClaudeAuthLoginFlow | null = null;
  return {
    getUsageSummary: async () => state === 'loading'
      ? new Promise<never>(() => {})
      : reviewUsageSummary('node-a', state ?? null),
    refreshUsageSummary: async () => {
      if (state === 'refresh-error') throw new Error('공개 예시 새로고침 실패');
      return reviewUsageSummary('node-a', state ?? null);
    },
    getClaudeAuthStatus: async () => ({ has_token: legacy }),
    getClaudeProfile: async () => legacy
      ? { email: 'legacy@example.invalid', display_name: '공개 예시 계정', has_claude_max: true }
      : null,
    startClaudeAuth: async () => ({ authUrl: 'fixture' }),
    submitClaudeCode: async () => ({ ok: true } as unknown as Response),
    deleteClaudeToken: async () => ({ ok: true } as unknown as Response),
    getClaudeAuthAccounts: async () => {
      // 받기 장면에서는 노드가 중앙 계정까지 함께 준 상태를 그린다. 화면은 로컬만 그려야 한다.
      if (state === 'receive-on') return centralReviewList(centralReviewAccounts);
      if (state === 'receive-off' || state === 'receive-pending' || state === 'receive-failure') {
        return {
          ...providerPanelClaudeReviewList,
          accounts: [
            { ...providerPanelClaudeReviewList.accounts[0]!, source: 'local' as const },
            { ...providerPanelClaudeReviewList.accounts[1]!, source: 'local' as const },
            { ...centralReviewAccounts[0]!, source: 'central' as const },
          ],
          pool: { ...providerPanelClaudeReviewList.pool!, available_count: 2, total_count: 3 },
        };
      }
      return current;
    },
    patchClaudeAuthAccount: async (_nodeId, accountId, patch) => {
      current = { ...current, accounts: current.accounts.map(account => account.id === accountId ? { ...account, ...patch } : account) };
      return current;
    },
    deleteClaudeAuthAccount: async (_nodeId, accountId) => {
      const account = current.accounts.find(item => item.id === accountId);
      if (account?.active_sessions) return { deferred: true, accounts: current.accounts, pool: current.pool };
      current = { ...current, accounts: current.accounts.filter(item => item.id !== accountId) };
      return { deferred: false, accounts: current.accounts, pool: current.pool };
    },
    startClaudeAuthLogin: async (_nodeId, accountId) => {
      flow = { login_id: 'review-login', account_id: accountId ?? null, state: 'url_ready', auth_url: 'fixture', expires_at: '2026-10-28T12:00:00.000Z', error: null };
      return flow;
    },
    getClaudeAuthLogin: async () => flow!,
    submitClaudeAuthLoginCode: async () => {
      flow = { ...flow!, state: 'failed', auth_url: null, error: { code: 'invalid_code', message: 'fixture' } };
      return flow;
    },
    cancelClaudeAuthLogin: async () => {
      flow = { ...flow!, state: 'cancelled', auth_url: null };
      return flow;
    },
    getCentralClaudeAuthAccounts: async () => {
      if (state === 'central-loading') return new Promise<never>(() => {});
      if (state === 'central-error') throw new Error('공개 예시 중앙 목록 실패');
      if (state === 'central-empty') return centralReviewList([]);
      if (state?.startsWith('central')) return centralReviewList(centralReviewAccounts);
      if (state === 'receive-on') return centralReviewList(centralReviewAccounts.map(account => ({ ...account, source: 'central' as const })));
      if (state === 'receive-off' || state === 'receive-pending' || state === 'receive-failure') {
        // 노드가 받은 목록에는 로컬 계정과 중앙 계정이 함께 온다. 화면은 로컬만 그린다.
        return {
          ...providerPanelClaudeReviewList,
          accounts: [
            { ...providerPanelClaudeReviewList.accounts[0]!, source: 'local' as const },
            { ...providerPanelClaudeReviewList.accounts[1]!, source: 'local' as const },
            { ...centralReviewAccounts[0]!, source: 'central' as const },
          ],
          pool: { ...providerPanelClaudeReviewList.pool!, available_count: 2, total_count: 3 },
        };
      }
      return current;
    },
    patchCentralClaudeAuthAccount: async (accountId, patch) => {
      current = {
        ...centralReviewList(centralReviewAccounts),
        accounts: centralReviewAccounts.map(account => account.id === accountId ? { ...account, ...patch } : account),
      };
      return current;
    },
    deleteCentralClaudeAuthAccount: async () => ({ success: true }),
    startCentralClaudeAuthLogin: async (accountId) => {
      const stateName = state === 'central-login-verifying' ? 'verifying'
        : state === 'central-login-failed' ? 'failed' : 'url_ready';
      flow = {
        login_id: 'review-central-login', account_id: accountId ?? null, state: stateName,
        auth_url: stateName === 'url_ready' ? 'fixture' : null,
        expires_at: '2026-10-28T12:00:00.000Z',
        error: stateName === 'failed' ? { code: 'invalid_code', message: 'fixture' } : null,
      };
      return flow;
    },
    getCentralClaudeAuthLogin: async () => flow!,
    submitCentralClaudeAuthLoginCode: async () => {
      flow = { ...flow!, state: 'verifying', auth_url: null };
      return flow;
    },
    cancelCentralClaudeAuthLogin: async () => {
      flow = { ...flow!, state: 'cancelled', auth_url: null };
      return flow;
    },
    getClaudeCentralSettings: async () => {
      if (state === 'receive-settings-error') throw new Error('공개 예시 설정 실패');
      return reviewCentralSettings(receiveSettingsState(state) ?? true);
    },
    putClaudeCentralReceive: async (_nodeId, receive) => {
      if (state === 'receive-pending') return new Promise<never>(() => {});
      if (state === 'receive-failure') throw new Error('공개 예시 저장 실패');
      return reviewCentralSettings(receive);
    },
  };
}


export function allBlockedReviewAccountList(): ClaudeAccountList {
  const accounts: ClaudeAccount[] = claudePoolReviewList.accounts.map(account => ({
    ...account,
    blocked: { until: '2026-10-28T14:30:00.000Z', scope: 'all' },
  }));
  return {
    ...claudePoolReviewList,
    accounts,
    pool: { ...claudePoolReviewList.pool!, available_count: 0 },
    fable_pool: { ...claudePoolReviewList.fable_pool!, available_count: 0 },
  };
}
