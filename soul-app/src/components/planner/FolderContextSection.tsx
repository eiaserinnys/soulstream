import { useMemo } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { Folder } from '../../api/types';
import { formatExecutionDefaultsSummary } from '../../lib/folder-settings';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { useExecutionDefaultsNames, useFolderContextChain, usePageSessionDefaults } from './useFolderContext';

/** Read-only summary of the folder's guidance, references and execution defaults with one 「설정」 entry. */
export function FolderContextSection({ api, folderId, folderPageId, folders, active, onOpenSettings }: {
  api: ApiClient | null;
  folderId: string;
  folderPageId: string;
  folders: readonly Folder[];
  active: boolean;
  onOpenSettings?: () => void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const chain = useFolderContextChain(api, folderId, folders, active);
  const defaults = usePageSessionDefaults(api, folderPageId, folders, active);
  const names = useExecutionDefaultsNames(api, defaults.data?.defaults ?? null);
  const guidance = chain.data?.guidance.map((item) => item.text).join('\n\n') ?? '';
  const references = chain.data?.atomReferences.map((item) => item.nodeTitle).join(', ') ?? '';
  const defaultsSummary = defaults.data ? formatExecutionDefaultsSummary(names) : '';
  const loading = chain.loading || defaults.loading || names.loading;
  const failed = Boolean(chain.error ?? defaults.error);
  const retry = () => { chain.retry(); defaults.retry(); };
  const value = (text: string, lines: number) => loading
    ? <ActivityIndicator style={styles.loading} color={t.colors.accent} />
    : <Text selectable style={[text ? styles.value : styles.empty, styles.keepAll]} numberOfLines={lines} lineBreakStrategyIOS="hangul-word">{text || '없음'}</Text>;
  return (
    <View style={styles.group}>
      <PlannerSectionHeader title="맥락" testID="planner-section-header-context"
        actionLabel={onOpenSettings ? '설정' : undefined} onAction={onOpenSettings} />
      <GroupedGlassSheet testID="folder-context-summary">
        {failed ? [
          <View key="failed" testID="folder-context-failed" style={styles.row}>
            <Text style={styles.error} accessibilityRole="alert" numberOfLines={2}>맥락을 불러오지 못했습니다.</Text>
            <TouchableOpacity testID="folder-context-retry" accessibilityRole="button" style={styles.action} onPress={retry}>
              <Text style={styles.link}>다시 시도</Text>
            </TouchableOpacity>
          </View>,
        ] : [
          <View key="guidance" testID="folder-context-guidance" style={[styles.row, styles.top]}>
            <Text style={styles.label}>지침</Text>
            {value(guidance, 2)}
          </View>,
          <View key="references" testID="folder-context-references" style={styles.row}>
            <Text style={styles.label}>참고 자료</Text>
            {value(references, 1)}
          </View>,
          <View key="defaults" testID="folder-context-defaults" style={styles.row}>
            <Text style={styles.label}>기본 실행 환경</Text>
            {value(defaultsSummary, 1)}
          </View>,
        ]}
      </GroupedGlassSheet>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    group: { gap: t.spacing.sm },
    row: {
      minHeight: planner.minHeight.context,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
      paddingHorizontal: t.cardLayout.padding,
      paddingVertical: t.uiSpacing.sm,
    },
    top: { alignItems: 'flex-start' },
    label: { width: planner.statusColumn + planner.contentIconFrame, color: t.colors.textSecondary, ...planner.typography.meta },
    value: { flex: 1, color: t.colors.textPrimary, ...planner.typography.body },
    empty: { flex: 1, color: t.colors.textTertiary, ...planner.typography.body },
    keepAll: Platform.OS === 'web' ? { wordBreak: 'keep-all' } as object : {},
    loading: { flex: 1, alignItems: 'flex-start' },
    error: { flex: 1, color: t.colors.errorText, ...planner.typography.body },
    action: { minWidth: planner.actionColumn, minHeight: planner.actionColumn, alignItems: 'center', justifyContent: 'center' },
    link: { color: t.colors.accent, ...planner.typography.label },
  });
}
