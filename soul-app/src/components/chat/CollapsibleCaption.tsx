import React, { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { DisclosureIcon } from '../DisclosureIcon';
import { useTokens, type DesignTokens } from '../../theme';

interface CollapsibleCaptionProps {
  title: string;
  children: ReactNode;
  initiallyCollapsed?: boolean;
}

export function CollapsibleCaption({
  title,
  children,
  initiallyCollapsed = true,
}: CollapsibleCaptionProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [expanded, setExpanded] = useState(() => !initiallyCollapsed);

  return (
    <View style={styles.wrapper}>
      <CompactTouchTarget
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        frameStyle={styles.touchFrame}
        surfaceStyle={styles.surface}
      >
        <View style={styles.titleRow}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
            {title}
          </Text>
          <DisclosureIcon expanded={expanded} color={t.colors.textPlaceholder} />
        </View>
      </CompactTouchTarget>
      {expanded ? <View style={styles.content}>{children}</View> : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    wrapper: {
      paddingHorizontal: t.spacing.lg,
    },
    touchFrame: {
      alignSelf: 'stretch',
    },
    surface: {
      alignSelf: 'stretch',
      width: '100%',
      minHeight: t.uiSpacing.xl,
      paddingHorizontal: t.uiSpacing.sm,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
      width: '100%',
    },
    title: {
      flex: 1,
      flexShrink: 1,
      marginStart: -t.uiSpacing.sm,
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
    content: {
      marginTop: t.uiSpacing.xxs,
    },
  });
}
