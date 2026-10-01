import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ROOT_SECTION_CONFIG,
  type RootSectionKey,
} from '../../navigation/rootSectionConfig';
import { useTokens, type DesignTokens } from '../../theme';

export const ROOT_HEADER_MAX_FONT_MULTIPLIER = 2;

export function RootSectionHeaderTitle({
  section,
  title: titleOverride,
}: {
  section: RootSectionKey;
  title?: string;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const config = ROOT_SECTION_CONFIG[section];
  const title = titleOverride ?? config.title;
  return (
    <View
      testID={`root-header-${section}`}
      style={styles.container}
      accessibilityRole="header"
      accessibilityLabel={title}
    >
      <Ionicons
        testID={`root-header-icon-${section}`}
        name={config.icon}
        color={t.colors.textPrimary}
        size={t.foundation.typography.navigation.fontSize}
        allowFontScaling
        maxFontSizeMultiplier={ROOT_HEADER_MAX_FONT_MULTIPLIER}
        accessible={false}
      />
      <Text
        testID={`root-header-title-${section}`}
        style={styles.title}
        numberOfLines={1}
        ellipsizeMode="tail"
        allowFontScaling
        maxFontSizeMultiplier={ROOT_HEADER_MAX_FONT_MULTIPLIER}
        accessible={false}
      >
        {title}
      </Text>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: {
      minHeight: t.foundation.minHeight.secondary,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      flexShrink: 1,
    },
    title: {
      color: t.colors.textPrimary,
      ...t.foundation.typography.navigation,
      flexShrink: 1,
    },
  });
}
