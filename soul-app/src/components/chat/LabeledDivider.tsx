import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';

interface LabeledDividerProps {
  label: string;
  alignmentInset?: 'avatar' | 'content';
  lineColor?: string;
}

export function LabeledDivider({ label, alignmentInset = 'avatar', lineColor }: LabeledDividerProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, alignmentInset, lineColor), [t, alignmentInset, lineColor]);

  return (
    <View style={styles.row}>
      <View testID="labeled-divider-left-line" accessibilityElementsHidden importantForAccessibility="no" style={styles.line} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.label}>{label}</Text>
      <View testID="labeled-divider-right-line" accessibilityElementsHidden importantForAccessibility="no" style={styles.line} />
    </View>
  );
}

function makeStyles(t: DesignTokens, alignmentInset: 'avatar' | 'content', lineColor?: string) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.md,
      marginVertical: t.uiSpacing.xxxl,
      paddingHorizontal: alignmentInset === 'content' ? 0 : t.spacing.lg,
    },
    line: {
      flex: 1,
      minWidth: t.uiSpacing.xl,
      height: StyleSheet.hairlineWidth,
      backgroundColor: lineColor ?? t.colors.border,
    },
    label: {
      flexShrink: 1,
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
  });
}
