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
  const [pressed, setPressed] = useState(false);

  return (
    <View style={styles.wrapper}>
      <CompactTouchTarget
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        activeOpacity={1}
        frameStyle={styles.touchFrame}
        surfaceStyle={styles.touchSurface}
      >
        <View style={styles.contentStack}>
          <View style={[styles.titleRow, pressed && styles.titlePressed]}>
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
              {title}
            </Text>
            <DisclosureIcon expanded={expanded} color={t.colors.textSecondary} />
          </View>
          {expanded ? <View style={styles.content}>{children}</View> : null}
        </View>
      </CompactTouchTarget>
    </View>
  );
}

/** Passive text only: the caption's single touch target owns all press behavior. */
export function CollapsibleCaptionLine({ children }: { children: ReactNode }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.contentLine}>
      {children}
    </Text>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    wrapper: {
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
    },
    touchFrame: {
      alignSelf: 'stretch',
    },
    touchSurface: {
      alignSelf: 'stretch',
      width: '100%',
      alignItems: 'stretch',
      justifyContent: 'flex-start',
    },
    contentStack: {
      width: '100%',
      minHeight: t.hitTarget.min,
      paddingTop: (t.hitTarget.min - t.uiSpacing.xl) / 2,
      gap: t.uiSpacing.xxs,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
      width: '100%',
      minHeight: t.uiSpacing.xl,
      borderRadius: t.foundation.radius.chip,
    },
    titlePressed: {
      backgroundColor: t.colors.surfaceMuted,
    },
    title: {
      flexShrink: 1,
      color: t.colors.textSecondary,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
    content: {
      gap: t.uiSpacing.xxs,
    },
    contentLine: {
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
  });
}
