import React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PersistentSessionWeeklyUsage } from '../components/persistent/PersistentSessionWeeklyUsage';
import { PERSISTENT_SESSION_FRAME } from '../components/persistent/persistentSessionFrame';
import { usageSummaryGaugesForApp } from '../lib/usage-summary-pool';
import type { AppUsageSummaryNode } from '../api/usageEndpoints';
import { useTokens } from '../theme';
import { allBlockedReviewAccountList, claudePoolReviewList } from './claude-account-pool-fixtures';
import type { ClaudeAccountList } from '../../../packages/soul-ui/src/lib/usage-summary';

export function ReviewClaudePoolPas() {
  const t = useTokens();
  const state = new URLSearchParams(window.location.search).get('state');
  const normal: ClaudeAccountList = {
    ...claudePoolReviewList,
    accounts: claudePoolReviewList.accounts.map(account => account.id === 'review-old'
      ? account : { ...account, enabled: true, auth_state: 'ok', blocked: null }),
    pool: { ...claudePoolReviewList.pool!, available_count: 3 },
    fable_pool: { ...claudePoolReviewList.fable_pool!, available_count: 3 },
  };
  const samples = state === 'blocked'
    ? [{ title: '전원 차단', list: allBlockedReviewAccountList() }]
    : [
      { title: '전수 가용', list: normal },
      { title: '일부 차단', list: claudePoolReviewList },
      { title: '전원 차단', list: allBlockedReviewAccountList() },
    ];
  const nodeFor = (list: ClaudeAccountList): AppUsageSummaryNode => ({
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
  });
  return <SafeAreaView testID="claude-pool-pas-review" edges={['bottom']} style={{ flex: 1, padding: t.foundation.pageInset,
    justifyContent: 'flex-end', backgroundColor: t.persistentSession.paper }}>
    <View style={{ width: PERSISTENT_SESSION_FRAME.portrait.tasks - 2 * t.uiSpacing.sm, alignSelf: 'flex-end', gap: t.spacing.md }}>
      {samples.map(sample => {
        const node = nodeFor(sample.list);
        return <View key={sample.title} style={{ gap: t.spacing.xs }}>
          <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>{sample.title}</Text>
          <PersistentSessionWeeklyUsage node={null} gauges={usageSummaryGaugesForApp(node)} loading={false} loadState="ready"
            evaluatedAtMs={Date.now()} onRetry={() => {}} onNextNode={() => {}} />
        </View>;
      })}
    </View>
  </SafeAreaView>;
}
