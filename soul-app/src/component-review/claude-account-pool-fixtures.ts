import type { ClaudeAccount, ClaudeAccountList, ClaudeAuthLoginFlow } from '../../../packages/soul-ui/src/lib/usage-summary';
import type { NodeProviderSectionsApi } from '../components/settings/NodeProviderSections';

export const claudePoolReviewList: ClaudeAccountList = {
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
    {
      id: 'review-old', email: 'expired@example.invalid', plan: 'Pro', enabled: false, priority: null,
      auth_state: 'needs_relogin', usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: '2026-10-26T23:10:00.000Z', blocked: null, active_sessions: 0,
    },
  ],
  pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 87, best_weekly_resets_at: '2026-10-30T12:00:00.000Z', earliest_available_at: '2026-10-28T14:30:00.000Z' },
  fable_pool: { available_count: 2, total_count: 3, best_weekly_remaining_percent: 82, best_weekly_resets_at: '2026-10-30T12:00:00.000Z', earliest_available_at: '2026-10-28T14:30:00.000Z' },
};

export function createClaudePoolReviewApi(): NodeProviderSectionsApi {
  let current: ClaudeAccountList = claudePoolReviewList;
  let flow: ClaudeAuthLoginFlow | null = null;
  return {
    getClaudeAuthAccounts: async () => current,
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
