import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { atomReferenceMeta, type ContextSource } from '../../lib/folder-settings';
import { useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassRow } from './GroupedGlassSheet';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';

/** Shared pieces of the folder settings, reference picker and new session sheets. */
export function useFolderContextPartStyles() {
  const t = useTokens();
  return { t, styles: useMemo(() => makeStyles(t), [t]) };
}

export function SourceToggle({ id, value, disabled, onChange }: {
  id: string; value: ContextSource; disabled?: boolean; onChange(value: ContextSource): void;
}) {
  return <SettingsSegmentedControl<ContextSource> id={id} value={value} onChange={onChange} disabled={disabled} evenRows
    options={[{ value: 'inherit', label: '물려받기' }, { value: 'own', label: '직접 정하기' }]} />;
}

export function SourceMark({ name, testID }: { name: string; testID?: string }) {
  const { t, styles } = useFolderContextPartStyles();
  return <View testID={testID} style={styles.source}>
    <Ionicons name="folder-outline" size={t.iconSize.compact} color={t.colors.textTertiary} />
    <Text style={styles.sourceText} numberOfLines={1}>{name}</Text>
  </View>;
}

export function HeadingRow({ title, children }: { title: string; children?: ReactNode }) {
  const { styles } = useFolderContextPartStyles();
  return <View style={styles.heading}>
    <Text accessibilityRole="header" style={styles.headingTitle}>{title}</Text>
    {children}
  </View>;
}

/** Read-only inherited value: nearest ancestor name above the value. */
export function InheritedValue({ testID, sourceName, text, empty, lines }: {
  testID?: string; sourceName: string | null; text: string | null; empty: string; lines?: number;
}) {
  const { styles } = useFolderContextPartStyles();
  return <View testID={testID} style={styles.inherited}>
    {sourceName && text ? <SourceMark name={sourceName} /> : null}
    <Text selectable style={text ? styles.inheritedText : styles.emptyText} numberOfLines={lines}
      lineBreakStrategyIOS="hangul-word">{text || empty}</Text>
  </View>;
}

export function AddRow({ label, testID, disabled, onPress }: {
  label: string; testID?: string; disabled?: boolean; onPress(): void;
}) {
  const { t, styles } = useFolderContextPartStyles();
  return <GroupedGlassRow testID={testID} accessibilityLabel={label} disabled={disabled} onPress={onPress} style={styles.addRow}>
    <Ionicons name="add" size={t.iconSize.standard} color={disabled ? t.colors.textMuted : t.colors.accent} />
    <Text style={[styles.addText, disabled && styles.disabledText]}>{label}</Text>
  </GroupedGlassRow>;
}

export interface ReferenceRowItem {
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
}

/** Inherited rows carry their source and stay read-only; own rows open the editor and can be removed. */
export function ReferenceRow({ item, testID, sourceName, disabled, onPress, onRemove }: {
  item: ReferenceRowItem; testID?: string; sourceName?: string; disabled?: boolean; onPress?(): void; onRemove?(): void;
}) {
  const { t, styles } = useFolderContextPartStyles();
  return <GroupedGlassRow testID={testID} accessibilityLabel={item.nodeTitle} disabled={disabled}
    onPress={sourceName ? undefined : onPress} style={styles.refRow}>
    <View style={styles.refBody}>
      <Text style={styles.refTitle} numberOfLines={1}>{item.nodeTitle}</Text>
      <Text style={styles.meta}>{atomReferenceMeta(item)}</Text>
    </View>
    {sourceName ? <SourceMark name={sourceName} /> : onRemove ? (
      <TouchableOpacity testID={testID ? `${testID}-remove` : undefined} accessibilityRole="button"
        accessibilityLabel={`${item.nodeTitle} 빼기`} disabled={disabled} style={styles.iconButton} onPress={onRemove}>
        <Ionicons name="close" size={t.iconSize.standard} color={t.colors.textTertiary} />
      </TouchableOpacity>
    ) : null}
  </GroupedGlassRow>;
}

const keepAll = Platform.OS === 'web' ? { wordBreak: 'keep-all' as const } : {};

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm, flexWrap: 'wrap', marginTop: t.spacing.xs },
    headingTitle: { color: t.colors.textPrimary, ...t.foundation.typography.section },
    source: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs, flexShrink: 1, maxWidth: '50%' },
    sourceText: { flexShrink: 1, color: t.colors.textTertiary, ...t.foundation.typography.meta },
    inherited: { padding: t.cardLayout.padding, gap: t.spacing.xs },
    inheritedText: { color: t.colors.textSecondary, ...t.foundation.typography.body, ...keepAll },
    emptyText: { color: t.colors.textTertiary, ...t.foundation.typography.body },
    refRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingLeft: t.cardLayout.padding, paddingRight: t.spacing.sm, minHeight: t.foundation.minHeight.field },
    refBody: { flex: 1, gap: t.spacing.xxs, paddingVertical: t.spacing.sm },
    refTitle: { color: t.colors.textPrimary, ...t.foundation.typography.body },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, paddingHorizontal: t.cardLayout.padding, minHeight: t.foundation.minHeight.field },
    addText: { color: t.colors.accent, ...t.foundation.typography.body },
    disabledText: { color: t.colors.textMuted },
    iconButton: { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, alignItems: 'center', justifyContent: 'center' },
  });
}
