import React, { useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { SettingsSurface } from './SettingsSurface';

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
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View testID={`settings-section-${id}`} style={styles.section}>
      <Text style={styles.title}>{title}</Text>
      <SettingsSurface
        flattened={flattened}
        role="glassSoft"
        style={[
          styles.surface,
          flattened && styles.flattenedSurface,
          contentStyle,
        ]}
      >
        {children}
      </SettingsSurface>
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
