import React, { useMemo, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from 'react-native';

import { useTextInputContentHeight } from '../chat/useTextInputContentHeight';
import { useTokens, type DesignTokens } from '../../theme';

/**
 * Form parts shared by the settings screens that list items and edit one of
 * them (recurring jobs, persistent agent sessions). One implementation, one
 * style table: a screen only supplies content.
 */
export function useSettingsFormStyles() {
  const t = useTokens();
  return useMemo(() => makeStyles(t), [t]);
}

export function SettingsInput({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  const t = useTokens(); const styles = useSettingsFormStyles();
  const [focused, setFocused] = useState(false);
  const { fontScale } = useWindowDimensions();
  const lineHeight = t.foundation.typography.body.lineHeight * fontScale;
  const measurement = useTextInputContentHeight(props.multiline ? props.value ?? '' : '', lineHeight);
  const singleLine = Math.max(t.hitTarget.min, lineHeight + t.spacing.sm * 2 + styles.input.borderWidth * 2);
  const height = Math.max(singleLine, props.value ? measurement.contentHeight + styles.input.borderWidth * 2 : 0);
  const expanded = height > singleLine;
  return <View><Text style={styles.label}>{label}</Text><TextInput {...props} accessibilityLabel={label}
    ref={props.multiline ? measurement.ref : undefined} onContentSizeChange={props.multiline ? measurement.onContentSizeChange : undefined}
    scrollEnabled={props.multiline ? false : undefined} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={[styles.input, props.multiline && { height, paddingVertical: expanded ? t.spacing.sm : (singleLine - lineHeight - styles.input.borderWidth * 2) / 2, textAlignVertical: expanded ? 'top' : 'center' }, focused && { borderColor: t.colors.accent, backgroundColor: t.colors.accentTint }]}
    placeholderTextColor={t.colors.textPlaceholder} /></View>;
}

export function SettingsAction({ label, onPress, disabled, primary = false, testID }: { label: string; onPress(): void; disabled?: boolean; primary?: boolean; testID?: string }) {
  const styles = useSettingsFormStyles();
  return <TouchableOpacity testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.action, primary && styles.actionPrimary, disabled && styles.disabled]}><Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text></TouchableOpacity>;
}

export function SettingsNotice({ text }: { text: string }) {
  const styles = useSettingsFormStyles();
  return <Text style={styles.help}>{text}</Text>;
}

/** List head: title and help on the left, its actions on the right. */
export function SettingsListHeader({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  const styles = useSettingsFormStyles();
  return <View style={styles.headerRow}>
    <View style={styles.grow}><Text style={styles.heading}>{title}</Text><Text style={styles.help}>{help}</Text></View>
    <View style={styles.actions}>{children}</View>
  </View>;
}

/** The whole row is one touch target: name, detail line and a disclosure mark. */
export function SettingsListRow({ title, detail, onPress, disabled = false, testID }: { title: string; detail: string; onPress(): void; disabled?: boolean; testID?: string }) {
  const styles = useSettingsFormStyles();
  return <TouchableOpacity testID={testID} style={styles.listRow} onPress={onPress} disabled={disabled} accessibilityRole="button"><View style={styles.grow}><Text style={styles.body}>{title}</Text><Text style={styles.help}>{detail}</Text></View><Text style={styles.disclosure}>›</Text></TouchableOpacity>;
}

/** A value the user can read but not edit. */
export function SettingsReadOnlyField({ label, value }: { label: string; value: string }) {
  const styles = useSettingsFormStyles();
  return <View><Text style={styles.label}>{label}</Text><Text style={styles.body}>{value}</Text></View>;
}

/** One editor group: a heading and its fields. */
export function SettingsFormGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  const styles = useSettingsFormStyles();
  return <View style={styles.group}>{title ? <Text style={styles.heading}>{title}</Text> : null}{children}</View>;
}

export function SettingsToggleRow({ label, value, onValueChange, disabled, testID, help }: {
  label: string;
  value: boolean;
  onValueChange(value: boolean): void;
  disabled?: boolean;
  testID?: string;
  help?: string;
}) {
  const styles = useSettingsFormStyles();
  return <View style={styles.listRow}>
    <View style={styles.grow}>
      <Text style={styles.body}>{label}</Text>
      {help ? <Text style={styles.help}>{help}</Text> : null}
    </View>
    <Switch accessibilityLabel={label} testID={testID} value={value} disabled={disabled} onValueChange={onValueChange} />
  </View>;
}

/** Props of the scroll page that holds a settings list or editor; a hidden page stays mounted. */
export function settingsPanelPage(t: DesignTokens, hidden: boolean) {
  return {
    style: { flex: 1, minHeight: 0, display: hidden ? 'none' as const : 'flex' as const },
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? 'no-hide-descendants' as const : 'auto' as const,
    contentContainerStyle: { padding: t.foundation.pageInset, gap: t.spacing.md },
    keyboardShouldPersistTaps: 'handled' as const,
  };
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    block: { gap: t.spacing.sm },
    editor: { paddingBottom: t.spacing.xl, gap: t.spacing.md },
    group: { padding: t.cardLayout.padding, gap: t.spacing.md },
    headerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm },
    grow: { flex: 1, minWidth: 0 },
    heading: { ...t.foundation.typography.body, fontWeight: '700', color: t.colors.textPrimary },
    label: { ...t.foundation.typography.body, color: t.colors.textSecondary, marginBottom: t.spacing.xs },
    help: { ...t.foundation.typography.body, color: t.colors.textMuted },
    error: { ...t.foundation.typography.body, color: t.colors.error },
    listRow: { flexDirection: 'row', gap: t.spacing.sm, alignItems: 'center', minHeight: t.hitTarget.min, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border },
    body: { ...t.foundation.typography.body, color: t.colors.textPrimary },
    disclosure: { color: t.colors.textMuted, fontSize: t.iconSize.standard },
    input: { minHeight: t.hitTarget.min, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, borderRadius: t.foundation.radius.field, color: t.colors.textPrimary, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, ...t.foundation.typography.body },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
    action: { minHeight: t.hitTarget.min, justifyContent: 'center', alignItems: 'center', paddingHorizontal: t.spacing.md, borderRadius: t.foundation.radius.field, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
    actionPrimary: { backgroundColor: t.colors.accent, borderColor: t.colors.accent },
    actionText: { ...t.foundation.typography.body, color: t.colors.textPrimary, fontWeight: '700' },
    actionTextPrimary: { color: t.colors.accentText },
    disabled: { opacity: 0.45 },
  });
}
