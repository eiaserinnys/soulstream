import React, { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { SessionEvent } from '../../api/types';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { getChatRowHorizontalInset } from '../chat/ChatBody.styles';

interface Props {
  event: SessionEvent;
  presentation?: 'default' | 'manuscript';
}

export function ThinkingEvent({ event, presentation = 'default' }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, presentation), [t, presentation]);

  const [expanded, setExpanded] = useState(false);
  const d = event.data as any;
  const text =
    (typeof d?.thinking === 'string' ? d.thinking : '') ||
    (typeof d?.delta === 'string' ? d.delta : '') ||
    '';

  if (!text) return null;

  if (presentation === 'manuscript') {
    return <Text testID="thinking-event-text" style={styles.manuscriptText}>{text}</Text>;
  }

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
      >
        <Text style={styles.icon}>💭</Text>
        <Text style={styles.label}>생각 중...</Text>
        <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.body}>
          <Text style={styles.text}>{text}</Text>
        </View>
      )}
    </View>
  );
}

function makeStyles(t: DesignTokens, presentation: 'default' | 'manuscript') {
  const c = t.colors;
  const sessionRoles = createSessionVisualRoles(t);
  return StyleSheet.create({
    manuscriptText: {
      alignSelf: 'stretch',
      marginVertical: sessionRoles.chat.messageGap / 2,
      color: c.textPrimary,
      fontSize: t.chatFontSize.body,
      lineHeight: t.chatFontSize.body * 1.6,
    },
    wrapper: {
      // ToolEvent와 동일하게 어시스턴트 말풍선 본문 시작 지점에 좌측 정렬한다.
      marginLeft: presentation === 'manuscript' ? 0 : t.assistantBubbleIndent,
      marginRight: getChatRowHorizontalInset(t, presentation),
      marginVertical: 3,
      borderRadius: t.radius.sm,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: c.borderSubtle,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: presentation === 'manuscript' ? t.persistentSession.panel : c.surfaceMuted,
      padding: t.spacing.sm,
      minHeight: t.hitTarget.min,
      gap: t.spacing.sm,
    },
    icon: { fontSize: t.chatFontSize.meta },
    label: {
      flex: 1,
      color: c.textMuted,
      fontSize: t.chatFontSize.meta,
      fontStyle: 'italic',
    },
    chevron: { color: c.textPlaceholder, fontSize: t.chatFontSize.meta },
    body: {
      backgroundColor: presentation === 'manuscript' ? t.persistentSession.panel : c.surfaceCode,
      padding: t.spacing.sm,
    },
    text: {
      color: c.textMuted,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      fontStyle: 'italic',
    },
  });
}
