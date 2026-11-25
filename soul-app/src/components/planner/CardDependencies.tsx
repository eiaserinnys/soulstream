import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { cardDependencyStopReason, type CardDependency } from '../../../../packages/wire-schema/src/card_dependency_display';
import { cardDependencyStatus } from '../../lib/card-transition';
import { useTokens, type DesignTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { CardStatusChip } from './CardRow';

const DEPENDENCY_VISIBLE_ROWS = 3;

/** 카드 상세 머리 아래의 「선행 카드」 묶음. 카드가 시작한 뒤에도 dependsOn이 있으면 남는다. */
export function CardDependencies({ dependencies, onOpenCard }: {
  dependencies: readonly CardDependency[];
  onOpenCard(cardId: string): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const metCount = dependencies.filter(dep => dep.met).length;
  // 3장까지는 모두 보이고, 4장부터는 넷째 행이 반쯤 보이는 높이에서 목록 안쪽만 스크롤한다(접기 토글 없음).
  const rowStep = t.hitTarget.min + t.uiSpacing.xxs;
  const maxListHeight = dependencies.length > DEPENDENCY_VISIBLE_ROWS ? rowStep * DEPENDENCY_VISIBLE_ROWS + t.hitTarget.min / 2 : undefined;
  return <View testID="card-dependencies" style={styles.group}>
    <View style={styles.head}>
      <Text accessibilityRole="header" style={styles.heading}>선행 카드</Text>
      <Text testID="card-dependencies-count" style={styles.count}>{`${metCount}/${dependencies.length}`}</Text>
    </View>
    <ScrollView testID="card-dependencies-list" nestedScrollEnabled style={maxListHeight ? { maxHeight: maxListHeight } : undefined}
      contentContainerStyle={styles.list} showsVerticalScrollIndicator={maxListHeight !== undefined}>
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
            tone={status.tone === 'error' ? 'error' : undefined} flush />
          <Ionicons name="chevron-forward" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </CompactTouchTarget>;
      })}
    </ScrollView>
  </View>;
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  return StyleSheet.create({
    // 폰 350x760에서도 본문 스크롤이 120px 이상 남도록 묶음의 세로 여백을 촘촘히 둔다.
    group: { paddingHorizontal: t.foundation.pageInset, marginBottom: t.uiSpacing.xs, gap: t.uiSpacing.xs },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.uiSpacing.sm },
    heading: { ...type.meta, fontWeight: '700', color: t.colors.textPrimary },
    count: { ...type.meta, color: t.colors.textSecondary },
    list: { gap: t.uiSpacing.xxs },
    rowFrame: { alignSelf: 'stretch', alignItems: 'stretch' },
    row: { flex: 1, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm,
      paddingHorizontal: t.uiSpacing.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: t.radius.floor },
    number: { ...type.meta, color: t.colors.textSecondary },
    title: { ...type.body, color: t.colors.textPrimary, flex: 1, minWidth: 0 },
  });
}
