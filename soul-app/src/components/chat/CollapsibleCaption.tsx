import React, { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { DisclosureIcon } from '../DisclosureIcon';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../../theme';

interface CollapsibleCaptionProps {
  title: string;
  children: ReactNode;
  initiallyCollapsed?: boolean;
  align?: 'start' | 'end';
}

const CaptionAlignContext = createContext<'start' | 'end'>('start');

export function CollapsibleCaption({
  title,
  children,
  initiallyCollapsed = true,
  align = 'start',
}: CollapsibleCaptionProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, align), [t, align]);
  const [expanded, setExpanded] = useState(() => !initiallyCollapsed);
  const [pressed, setPressed] = useState(false);

  return (
    <CaptionAlignContext.Provider value={align}>
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
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.title, pressed && styles.titlePressedText]}
              >
                {title}
              </Text>
              <DisclosureIcon
                expanded={expanded}
                color={pressed ? t.colors.textSecondary : t.colors.textPlaceholder}
              />
            </View>
            {expanded ? <View style={styles.content}>{children}</View> : null}
          </View>
        </CompactTouchTarget>
      </View>
    </CaptionAlignContext.Provider>
  );
}

/** Passive text only: the caption's single touch target owns all press behavior. */
export function CollapsibleCaptionLine({ children }: { children: ReactNode }) {
  const t = useTokens();
  const align = useContext(CaptionAlignContext);
  const styles = useMemo(() => makeStyles(t, align), [t, align]);
  return (
    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.contentLine}>
      {children}
    </Text>
  );
}

function makeStyles(t: DesignTokens, align: 'start' | 'end') {
  const endAligned = align === 'end';
  const bubbleMaxWidth = createSessionVisualRoles(t).chat.bubbleMaxWidth;
  return StyleSheet.create({
    wrapper: {
      paddingHorizontal: endAligned ? t.spacing.md : t.spacing.lg,
    },
    touchFrame: {
      alignSelf: 'stretch',
    },
    touchSurface: {
      alignSelf: endAligned ? 'flex-end' : 'stretch',
      width: endAligned ? bubbleMaxWidth : '100%',
      marginRight: endAligned ? t.avatarSize.message + t.spacing.sm : 0,
      alignItems: 'stretch',
      justifyContent: 'flex-start',
    },
    contentStack: {
      width: '100%',
      minHeight: t.hitTarget.min,
      paddingTop: (t.hitTarget.min - t.uiSpacing.xl) / 2,
      paddingBottom: (t.hitTarget.min - t.uiSpacing.xl) / 2,
      gap: t.uiSpacing.xxs,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
      alignSelf: endAligned ? 'flex-end' : 'flex-start',
      maxWidth: '100%',
      minHeight: t.uiSpacing.xl,
      paddingHorizontal: t.uiSpacing.sm,
      marginLeft: endAligned ? 0 : -t.uiSpacing.sm,
      marginRight: endAligned ? -t.uiSpacing.sm : 0,
      borderRadius: t.foundation.radius.chip,
    },
    titlePressed: {
      backgroundColor: t.colors.surfaceMuted,
    },
    title: {
      flexShrink: 1,
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
    titlePressedText: {
      color: t.colors.textSecondary,
    },
    content: {
      alignSelf: endAligned ? 'flex-end' : 'flex-start',
      width: '100%',
      gap: t.uiSpacing.xxs,
    },
    contentLine: {
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      textAlign: endAligned ? 'right' : 'left',
    },
  });
}
