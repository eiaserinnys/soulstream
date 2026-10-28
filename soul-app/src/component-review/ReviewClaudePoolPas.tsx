import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PersistentSessionWeeklyUsage } from '../components/persistent/PersistentSessionWeeklyUsage';
import { PERSISTENT_SESSION_FRAME } from '../components/persistent/persistentSessionFrame';
import { usageSummaryGaugesForApp } from '../lib/usage-summary-pool';
import type { AppUsageSummaryNode } from '../api/usageEndpoints';
import { useTokens } from '../theme';
import { allBlockedReviewAccountList, claudePoolReviewList } from './claude-account-pool-fixtures';

export function ReviewClaudePoolPas() {
  const t = useTokens();
  const blocked = new URLSearchParams(window.location.search).get('state') === 'blocked';
  const list = blocked ? allBlockedReviewAccountList() : claudePoolReviewList;
  const node: AppUsageSummaryNode = {
    nodeId: 'node-a', fetchedAt: '2026-10-28T09:10:00.000Z', stale: false, staleSince: null,
    providers: {
      claude: {
        status: 'auto', source: null, sourceKind: 'unknown', observedAt: '2026-10-28T09:10:00.000Z',
        weeklyRemainingPercent: 87, weeklyResetAt: 1_793_318_400, shortRemainingPercent: 76, shortResetAt: null, quotas: [
          { id: 'claude:weekly_scoped:fable', label: 'Fable', window: '7d', model: 'Fable', remainingPercent: 82, resetAt: 1_793_318_400 },
        ], mode: 'pool', accounts: list.accounts, pool: list.pool, fable_pool: list.fable_pool,
      },
      codex: { status: 'auto', weeklyRemainingPercent: 44, weeklyResetAt: 1_793_318_400, shortRemainingPercent: null, shortResetAt: null, quotas: [] },
      antigravity: null,
    },
  };
  const gauges = usageSummaryGaugesForApp(node);
  return <SafeAreaView testID="claude-pool-pas-review" edges={['bottom']} style={{ flex: 1, padding: t.foundation.pageInset,
    justifyContent: 'flex-end', backgroundColor: t.persistentSession.paper }}>
    <View style={{ width: PERSISTENT_SESSION_FRAME.portrait.tasks - 2 * t.uiSpacing.sm, alignSelf: 'flex-end' }}>
      <PersistentSessionWeeklyUsage node={node} gauges={gauges} loading={false} loadState="ready"
        evaluatedAtMs={Date.now()} onRetry={() => {}} onNextNode={() => {}} />
    </View>
  </SafeAreaView>;
}
