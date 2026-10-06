import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';

interface LabeledDividerProps {
  label: string;
  alignmentInset?: 'avatar' | 'content';
}

export function LabeledDivider({ label, alignmentInset = 'avatar' }: LabeledDividerProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, alignmentInset), [t, alignmentInset]);

  return (
    <View style={styles.row}>
      <View testID="labeled-divider-left-line" accessibilityElementsHidden importantForAccessibility="no" style={styles.line} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.label}>{label}</Text>
      <View testID="labeled-divider-right-line" accessibilityElementsHidden importantForAccessibility="no" style={styles.line} />
    </View>
  );
}

function makeStyles(t: DesignTokens, alignmentInset: 'avatar' | 'content') {
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
