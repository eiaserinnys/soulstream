import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';

interface LabeledDividerProps {
  label: string;
}

export function LabeledDivider({ label }: LabeledDividerProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View style={styles.row}>
      <View accessibilityElementsHidden importantForAccessibility="no" style={styles.line} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.label}>{label}</Text>
      <View accessibilityElementsHidden importantForAccessibility="no" style={styles.line} />
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.md,
      marginVertical: t.uiSpacing.xxxl,
      paddingHorizontal: t.spacing.lg,
    },
    line: {
      flex: 1,
      minWidth: 0,
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.colors.border,
    },
    label: {
      flexShrink: 1,
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
  });
}
