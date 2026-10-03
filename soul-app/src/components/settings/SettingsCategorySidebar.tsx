import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { SETTINGS_CATEGORIES, type SettingsCategory } from './settingsCategories';

export function SettingsCategorySidebar({ selected, onSelect, showAdmin = false, compact = false }: {
  selected: SettingsCategory | null; onSelect(value: SettingsCategory): void; showAdmin?: boolean; compact?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return <View testID="settings-category-sidebar" style={[styles.sidebar, compact && styles.compact]}>
    {['개인 환경', '작업과 실행', '서버 관리'].map(group => <View key={group} style={styles.group}>
      <Text style={styles.groupTitle}>{group}</Text>
      <View style={compact && styles.groupCard}>
      {SETTINGS_CATEGORIES.filter(category => category.group === group && (category.id !== 'review-policy' || showAdmin)).map(category => {
        const active = !compact && category.id === selected;
        return <TouchableOpacity key={category.id} testID={`settings-category-${category.id}`}
          accessibilityRole="button" accessibilityState={{ selected: active }}
          style={[styles.row, compact && styles.compactRow, active && styles.activeRow]} onPress={() => onSelect(category.id)}>
          <View style={compact && styles.iconCap}><Ionicons name={category.icon} size={t.iconSize.standard} color={active ? t.colors.accent : t.colors.textSecondary}/></View>
          <View style={styles.labels}><Text style={[styles.label, active && styles.activeLabel]}>{category.label}</Text>
            {compact ? <Text style={styles.description}>{category.description}</Text> : null}
          </View>
          {compact || active ? <Ionicons name="chevron-forward" size={t.iconSize.compact} color={t.colors.textSecondary}/> : null}
        </TouchableOpacity>;
      })}</View>
    </View>)}
  </View>;
}
function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    // Preserve the existing iPad settings sidebar width.
    sidebar: { width: 240, padding: t.spacing.md, gap: t.spacing.lg, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: t.colors.border, backgroundColor: t.colors.surfaceMuted },
    compact: { width: '100%', padding: t.foundation.pageInset, paddingTop: t.spacing.sm, backgroundColor: 'transparent', borderRightWidth: 0, gap: t.spacing.lg },
    group: { gap: t.spacing.sm },
    groupTitle: { ...t.foundation.typography.meta, fontWeight: '600', color: t.colors.textSecondary, paddingHorizontal: t.spacing.sm },
    groupCard: { borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, backgroundColor: t.colors.surfaceMuted, borderRadius: t.foundation.radius.field, overflow: 'hidden' },
    row: { minHeight: t.hitTarget.min, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, borderRadius: t.foundation.radius.field },
    compactRow: { paddingHorizontal: t.cardLayout.padding, borderRadius: 0 },
    iconCap: { width: t.iconSize.hero, height: t.iconSize.hero, borderRadius: t.radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceMuted },
    labels: { flex: 1, gap: t.spacing.xxs },
    activeRow: { backgroundColor: t.colors.accentTint },
    label: { ...t.foundation.typography.body, color: t.colors.textPrimary },
    description: { ...t.foundation.typography.body, color: t.colors.textSecondary },
    activeLabel: { color: t.colors.textPrimary, fontWeight: '700' },
  });
}
