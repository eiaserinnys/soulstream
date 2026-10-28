import React, { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SettingsSection } from '../components/settings/SettingsSection';
import { ClaudeAccountPoolSection } from '../components/settings/ClaudeAccountPoolSection';
import { useTokens } from '../theme';
import { claudePoolReviewList, createClaudePoolReviewApi } from './claude-account-pool-fixtures';

export function ReviewClaudeAccountPool() {
  const t = useTokens();
  const api = useMemo(() => createClaudePoolReviewApi(), []);
  return <SafeAreaView testID="claude-pool-review-safe-area" edges={['top', 'bottom']}
    style={{ flex: 1, backgroundColor: t.colors.background }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: t.spacing.xl }}>
      <SettingsSection id="ai-backend" title="node-a" flattened={false}>
        <ClaudeAccountPoolSection nodeId="node-a" initialList={claudePoolReviewList} api={api} />
      </SettingsSection>
    </ScrollView>
  </SafeAreaView>;
}
