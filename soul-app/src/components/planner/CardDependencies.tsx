import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { CardDependency } from '../../../../packages/wire-schema/src/card_dependency_display';
import { cardDependencyStopReason } from '../../../../packages/wire-schema/src/card_dependency_display';
import { cardDependencyStatus } from '../../lib/card-transition';
import { useTokens, type DesignTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { CardStatusChip } from './CardRow';

/** 카드 상세 머리 아래의 「선행 카드」 묶음. 카드가 시작한 뒤에도 dependsOn이 있으면 남는다. */
export function CardDependencies({ dependencies, onOpenCard }: {
  dependencies: readonly CardDependency[];
  onOpenCard(cardId: string): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const metCount = dependencies.filter(dep => dep.met).length;
  return <View testID="card-dependencies" style={styles.group}>
    <View style={styles.head}>
      <Text accessibilityRole="header" style={styles.heading}>선행 카드</Text>
      <Text testID="card-dependencies-count" style={styles.count}>{`${metCount}/${dependencies.length}`}</Text>
    </View>
    <View style={styles.list}>
      {dependencies.map(dep => {
        const stopped = cardDependencyStopReason(dep) !== null;
        const status = cardDependencyStatus(dep);
        return <CompactTouchTarget key={dep.id} testID={`card-dependency-${dep.id}`} accessibilityRole="button"
          accessibilityLabel={`${dep.number == null ? '' : `#${dep.number} `}${dep.title}, ${status.label}, 카드 열기`}
          frameStyle={styles.rowFrame} surfaceTestID={`card-dependency-surface-${dep.id}`}
          surfaceStyle={[styles.row, { borderColor: stopped ? t.colors.error : t.colors.border }]}
          onPress={() => onOpenCard(dep.id)}>
          {dep.number == null ? null : <Text testID={`card-dependency-number-${dep.id}`} style={styles.number}>{`#${dep.number}`}</Text>}
          <Text testID={`card-dependency-title-${dep.id}`} style={styles.title} numberOfLines={1} ellipsizeMode="tail">{dep.title}</Text>
          <CardStatusChip testID={`card-dependency-chip-${dep.id}`} card={{ id: dep.id, status: dep.status, blockedKind: null }} detail label={status.label}
            tone={status.tone === 'error' ? 'error' : undefined} />
          <Ionicons name="chevron-forward" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </CompactTouchTarget>;
      })}
    </View>
  </View>;
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  return StyleSheet.create({
    group: { paddingHorizontal: t.foundation.pageInset, marginBottom: t.uiSpacing.sm, gap: t.uiSpacing.sm },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.uiSpacing.sm },
    heading: { ...type.cardTitle, color: t.colors.textPrimary },
    count: { ...type.meta, color: t.colors.textSecondary },
    list: { gap: t.uiSpacing.xs },
    rowFrame: { alignSelf: 'stretch', alignItems: 'stretch' },
    row: { flex: 1, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm,
      paddingHorizontal: t.uiSpacing.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: t.radius.floor },
    number: { ...type.meta, color: t.colors.textSecondary },
    title: { ...type.body, color: t.colors.textPrimary, flex: 1, minWidth: 0 },
  });
}
