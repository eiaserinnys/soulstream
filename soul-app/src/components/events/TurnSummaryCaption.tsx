import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { createSessionVisualRoles } from '../../theme/sessionVisualRoles';

interface Props {
  content: string;
  presentation?: 'default' | 'manuscript';
}

export function TurnSummaryCaption({ content, presentation = 'default' }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View testID="turn-summary-caption" style={presentation === 'manuscript'
      ? [styles.wrapper, { marginHorizontal: 0, paddingLeft: 0 }]
      : styles.wrapper}>
      <View testID="turn-summary-caption-bubble" style={styles.bubble}>
        <Text testID="turn-summary-caption-text" style={styles.text}>
          {content}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  const sessionRoles = createSessionVisualRoles(t);
  return StyleSheet.create({
    wrapper: {
      alignItems: 'flex-start',
      marginHorizontal: t.spacing.md,
      paddingLeft: t.assistantBubbleIndent,
      paddingVertical: t.spacing.xs,
    },
    bubble: {
      alignSelf: 'flex-start',
      flexShrink: 1,
      ...roles.glassSoft.tokenStyle,
      borderRadius: t.radius.lg,
      borderBottomLeftRadius: 4,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      maxWidth: sessionRoles.chat.bubbleMaxWidth,
    },
    text: {
      color: t.colors.textSecondary,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      textAlign: 'left',
    },
  });
}
