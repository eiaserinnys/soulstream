import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PersistentReportEntry } from '../../api/types';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { CardStatusChip } from '../planner/CardRow';
import { cardDetailStyles } from '../planner/CardDetail.styles';
import { persistentReportStatusCard } from '../../lib/persistent-report-card';

export function PersistentReportCardSheetHeader({ entry, onCollapse }: {
  entry: PersistentReportEntry; onCollapse(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const statusCard = persistentReportStatusCard(entry);
  const iconOverhang = (t.hitTarget.min - t.foundation.iconFrame.compact) / 2;

  return <View style={styles.header}>
    <View style={styles.headerRow}>
      <Text style={styles.heading} numberOfLines={2}>
        {statusCard ? <><CardStatusChip card={statusCard} detail />{' '}</> : null}
        {entry.title}
      </Text>
      <View style={{ marginRight: -iconOverhang }}>
        <GlassButton testID="persistent-report-card-sheet-collapse" iconOnly size="compact"
          borderRadius={t.foundation.radius.round} accessibilityLabel="축소" accessibilityState={{ expanded: true }}
          onPress={onCollapse}>
          <Ionicons name="contract-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
        </GlassButton>
      </View>
    </View>
  </View>;
}
