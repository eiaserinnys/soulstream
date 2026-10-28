import type { ClaudeAccount, UsageSummarySnapshot } from '../../../../packages/soul-ui/src/lib/usage-summary';
import { usageSummaryGaugesForApp } from '../usage-summary-pool';
import type { AppUsageSummarySnapshot } from '../../api/usageEndpoints';

function account(id: string): ClaudeAccount {
  return {
    id, email: `${id}@example.invalid`, plan: null, enabled: true, priority: 1,
    auth_state: 'ok', usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: null, blocked: null, active_sessions: 0,
  };
}

function summary(provider: Record<string, unknown>): AppUsageSummarySnapshot {
  const base: UsageSummarySnapshot = {
    generatedAt: '2026-10-28T00:00:00.000Z', collectedAt: null,
    nodes: [{ nodeId: 'node-a', fetchedAt: null, stale: false, staleSince: null, providers: {
      claude: { status: 'auto', source: null, sourceKind: 'unknown', observedAt: null, weeklyRemainingPercent: 71,
        weeklyResetAt: 1_800_352_800, shortRemainingPercent: null, shortResetAt: null, quotas: [] },
      codex: null, antigravity: null,
    } }],
  };
  return {
    ...base,
    nodes: base.nodes.map(node => ({ ...node, providers: { ...node.providers, claude: { ...node.providers.claude!, ...provider } } })),
  } as AppUsageSummarySnapshot;
}

test('pool fields are optional and legacy Claude weekly gauges keep the existing label and value', () => {
  const legacy = summary({});
  expect(usageSummaryGaugesForApp(legacy.nodes[0]!)).toMatchObject([
    { id: 'claude', label: 'Claude', remainingPercent: 71 },
  ]);
});

test('one account keeps the existing summary while multi-account pools show available/total', () => {
  const one = summary({ mode: 'pool', accounts: [account('one')], pool: {
    available_count: 1, total_count: 1, best_weekly_remaining_percent: 71, best_weekly_resets_at: null, earliest_available_at: null,
  } });
  const multiple = summary({ mode: 'pool', accounts: [account('one'), account('two')], pool: {
    available_count: 2, total_count: 3, best_weekly_remaining_percent: 71, best_weekly_resets_at: null, earliest_available_at: null,
  } });
  expect(usageSummaryGaugesForApp(one.nodes[0]!)[0]).toMatchObject({ label: 'Claude', remainingPercent: 71 });
  expect(usageSummaryGaugesForApp(multiple.nodes[0]!)[0]).toMatchObject({ label: 'Claude', poolFraction: '2/3', poolState: 'partial', remainingPercent: 71 });
});

test('fully available pools label the split fraction as normal', () => {
  const normal = summary({ mode: 'pool', pool: {
    available_count: 3, total_count: 3, best_weekly_remaining_percent: 71,
    best_weekly_resets_at: null, earliest_available_at: null,
  } });
  expect(usageSummaryGaugesForApp(normal.nodes[0]!)[0]).toMatchObject({
    label: 'Claude', poolFraction: '3/3', poolState: 'normal', remainingPercent: 71,
  });
});

test('partially blocked pools keep the best weekly value and all-blocked pools show local reset with zero', () => {
  const partial = summary({ mode: 'pool', pool: {
    available_count: 1, total_count: 2, best_weekly_remaining_percent: 41, best_weekly_resets_at: null,
    earliest_available_at: '2026-10-28T14:30:00.000Z',
  } });
  const allBlocked = summary({ mode: 'pool', pool: {
    available_count: 0, total_count: 2, best_weekly_remaining_percent: 41, best_weekly_resets_at: null,
    earliest_available_at: '2026-10-28T14:30:00.000Z',
  } });
  expect(usageSummaryGaugesForApp(partial.nodes[0]!)[0]).toMatchObject({ label: 'Claude', poolFraction: '1/2', poolState: 'partial', remainingPercent: 71 });
  const blockedGauge = usageSummaryGaugesForApp(allBlocked.nodes[0]!)[0];
  const expected = new Date('2026-10-28T14:30:00.000Z').toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  expect(blockedGauge).toMatchObject({ label: 'Claude', poolFraction: '0/2', poolState: 'blocked', remainingPercent: 0, resetLabel: `${expected} 해제` });
});
