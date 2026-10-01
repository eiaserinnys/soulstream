import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { SessionEvent } from '../../api/types';
import { useTokens, type DesignTokens } from '../../theme';
import { buildSystemEventText } from './eventActions';

interface Props {
  event: SessionEvent;
}

export function SystemEvent({ event }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  const text = buildSystemEventText(event);

  return (
    <View style={styles.wrapper}>
      <Text style={styles.text}>
        — {text} —
      </Text>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    wrapper: {
      alignItems: 'flex-start',
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
    },
    text: {
      color: t.colors.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      fontStyle: 'italic',
      textAlign: 'left',
    },
  });
}
