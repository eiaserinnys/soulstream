import React, { Children, isValidElement, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { SettingsSurface } from './SettingsSurface';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';

export function SettingsSection({
  id,
  title,
  flattened,
  children,
  contentStyle,
}: {
  id: string;
  title: string;
  flattened: boolean;
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const workspace = useSettingsWorkspace();
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View testID={`settings-section-${id}`} style={styles.section}>
      {!workspace && title ? <Text style={styles.title}>{title}</Text> : null}
      {workspace ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.md }}>
        {Children.toArray(children).filter(child => !isValidElement(child) || child.type !== SettingsDivider).map((child, index) => <SettingsSurface key={isValidElement(child) ? child.key ?? index : index} flattened={flattened} role="glassSoft" style={[styles.surface, flattened && styles.flattenedSurface, { width: workspace.columns && Children.count(children) > 1 ? '47%' : '100%', flexGrow: 1 }, contentStyle]}>{child}</SettingsSurface>)}
      </View> : <SettingsSurface flattened={flattened} role="glassSoft" style={[styles.surface, flattened && styles.flattenedSurface, contentStyle]}>{children}</SettingsSurface>}

    </View>
  );
}

export function SettingsDivider({ testID }: { testID?: string }) {
  const t = useTokens();
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border }}
    />
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    section: { marginBottom: t.spacing.xxl },
    title: {
      ...t.foundation.typography.section,
      color: t.colors.textSecondary,
      marginBottom: t.spacing.sm,
      paddingHorizontal: t.spacing.xs,
    },
    surface: {
      overflow: 'hidden',
      borderRadius: t.foundation.radius.card,
    },
    flattenedSurface: {
      backgroundColor: t.colors.surfaceMuted,
      borderColor: t.colors.border,
      borderWidth: StyleSheet.hairlineWidth,
    },
  });
}
