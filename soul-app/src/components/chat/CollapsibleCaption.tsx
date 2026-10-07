import React, { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { DisclosureIcon } from '../DisclosureIcon';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../../theme';

interface CollapsibleCaptionProps {
  title: string;
  expandedTitle?: string;
  children: ReactNode;
  initiallyCollapsed?: boolean;
  align?: 'start' | 'end';
  alignmentInset?: 'avatar' | 'content';
}

interface CollapsibleCaptionHeaderProps {
  title: string;
  expandedTitle?: string;
  expanded: boolean;
  pressed?: boolean;
  titleCanShrink?: boolean;
  alignTrailingEdge?: boolean;
  align?: 'start' | 'end';
  alignmentInset?: 'avatar' | 'content';
}

interface CollapsibleCaptionBodyProps {
  children: ReactNode;
  align?: 'start' | 'end';
  alignmentInset?: 'avatar' | 'content';
}

interface CollapsibleCaptionTriggerProps {
  title: string;
  expandedTitle?: string;
  expanded: boolean;
  onToggle(): void;
  align?: 'start' | 'end';
  alignmentInset?: 'avatar' | 'content';
}

const CaptionAlignContext = createContext<'start' | 'end'>('start');

export function CollapsibleCaption({
  title,
  expandedTitle,
  children,
  initiallyCollapsed = true,
  align = 'start',
  alignmentInset = 'avatar',
}: CollapsibleCaptionProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, align, alignmentInset), [t, align, alignmentInset]);
  const [expanded, setExpanded] = useState(() => !initiallyCollapsed);
  const [pressed, setPressed] = useState(false);

  return (
    <CaptionAlignContext.Provider value={align}>
      <View testID="collapsible-caption-wrapper" style={styles.wrapper}>
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
            <CollapsibleCaptionHeader
              title={title}
              expandedTitle={expandedTitle}
              expanded={expanded}
              pressed={pressed}
              align={align}
              alignmentInset={alignmentInset}
            />
            {expanded ? (
              <CollapsibleCaptionBody align={align} alignmentInset={alignmentInset}>
                {children}
              </CollapsibleCaptionBody>
            ) : null}
          </View>
        </CompactTouchTarget>
      </View>
    </CaptionAlignContext.Provider>
  );
}

export function CollapsibleCaptionHeader({
  title,
  expandedTitle,
  expanded,
  pressed = false,
  titleCanShrink = true,
  alignTrailingEdge = false,
  align = 'start',
  alignmentInset = 'avatar',
}: CollapsibleCaptionHeaderProps) {
  const t = useTokens();
  const styles = useMemo(
    () => makeStyles(t, align, alignmentInset, alignTrailingEdge),
    [t, align, alignmentInset, alignTrailingEdge],
  );
  return (
    <View style={[styles.titleRow, pressed && styles.titlePressed]}>
      <Text
        {...(expanded && expandedTitle !== undefined
          ? {}
          : { numberOfLines: 1 as const, ellipsizeMode: 'tail' as const })}
        style={[styles.title, !titleCanShrink && styles.titleNoShrink, pressed && styles.titlePressedText]}
      >
        {expanded ? expandedTitle ?? title : title}
      </Text>
      <DisclosureIcon
        expanded={expanded}
        color={pressed ? t.colors.textSecondary : t.colors.textPlaceholder}
      />
    </View>
  );
}

/** Interactive header only, for disclosures whose expanded content has its own controls. */
export function CollapsibleCaptionTrigger({
  title,
  expandedTitle,
  expanded,
  onToggle,
  align = 'start',
  alignmentInset = 'avatar',
}: CollapsibleCaptionTriggerProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, align, alignmentInset), [t, align, alignmentInset]);
  const [pressed, setPressed] = useState(false);

  return (
    <CompactTouchTarget
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      activeOpacity={1}
      frameStyle={styles.touchFrame}
      surfaceStyle={styles.touchSurface}
    >
      <View style={styles.contentStack}>
        <CollapsibleCaptionHeader
          title={title}
          expandedTitle={expandedTitle}
          expanded={expanded}
          pressed={pressed}
          align={align}
          alignmentInset={alignmentInset}
        />
      </View>
    </CompactTouchTarget>
  );
}

export function CollapsibleCaptionBody({
  children,
  align = 'start',
  alignmentInset = 'avatar',
}: CollapsibleCaptionBodyProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, align, alignmentInset), [t, align, alignmentInset]);
  return (
    <CaptionAlignContext.Provider value={align}>
      <View style={styles.content}>{children}</View>
    </CaptionAlignContext.Provider>
  );
}

/** Passive text only: the caption's single touch target owns all press behavior. */
export function CollapsibleCaptionLine({
  children,
  wrap = false,
}: {
  children: ReactNode;
  wrap?: boolean;
}) {
  const t = useTokens();
  const align = useContext(CaptionAlignContext);
  const styles = useMemo(() => makeStyles(t, align, 'avatar'), [t, align]);
  return (
    <Text
      {...(wrap ? {} : { numberOfLines: 1 as const, ellipsizeMode: 'tail' as const })}
      style={styles.contentLine}
    >
      {children}
    </Text>
  );
}

function makeStyles(
  t: DesignTokens,
  align: 'start' | 'end',
  alignmentInset: 'avatar' | 'content',
  alignTrailingEdge = false,
) {
  const endAligned = align === 'end';
  const bubbleMaxWidth = createSessionVisualRoles(t).chat.bubbleMaxWidth;
  const contentAligned = alignmentInset === 'content';
  return StyleSheet.create({
    wrapper: {
      paddingHorizontal: contentAligned ? 0 : endAligned ? t.spacing.md : t.spacing.lg,
    },
    touchFrame: {
      alignSelf: 'stretch',
    },
    touchSurface: {
      alignSelf: endAligned ? 'flex-end' : 'stretch',
      width: endAligned && !contentAligned ? bubbleMaxWidth : '100%',
      marginRight: endAligned && !contentAligned ? t.avatarSize.message + t.spacing.sm : 0,
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
      paddingRight: alignTrailingEdge ? 0 : t.uiSpacing.sm,
      marginLeft: endAligned ? 0 : -t.uiSpacing.sm,
      marginRight: endAligned && !alignTrailingEdge ? -t.uiSpacing.sm : 0,
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
    titleNoShrink: {
      flexShrink: 0,
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
