import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { SessionEvent } from '../../api/types';
import { useTokens, type DesignTokens } from '../../theme';
import { buildSystemEventText } from './eventActions';
import { getChatRowHorizontalInset } from '../chat/ChatBody.styles';

interface Props {
  event: SessionEvent;
  presentation?: 'default' | 'manuscript';
}

export function SystemEvent({ event, presentation = 'default' }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, presentation), [t, presentation]);

  const text = buildSystemEventText(event);

  return (
    <View style={styles.wrapper}>
      <Text style={styles.text}>
        — {text} —
      </Text>
    </View>
  );
}

function makeStyles(t: DesignTokens, presentation: 'default' | 'manuscript') {
  return StyleSheet.create({
    wrapper: {
      alignItems: 'flex-start',
      paddingVertical: t.spacing.sm,
      paddingHorizontal: getChatRowHorizontalInset(t, presentation, t.spacing.lg),
    },
    text: {
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      fontStyle: 'italic',
      textAlign: 'left',
    },
  });
}
