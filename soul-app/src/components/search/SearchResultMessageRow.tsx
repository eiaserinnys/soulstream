import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SearchMatchSource } from '../../api/client';
import { AppGlassPressable } from '../AppGlassCard';
import { useTokens, type DesignTokens } from '../../theme';

const EVENT_LABELS: Record<string, string> = {
  user_message: '메시지',
  user_text: '메시지',
  intervention_sent: '개입',
  assistant_message: '응답',
  assistant_text: '응답',
  text_delta: '응답',
  result: '결과',
  complete: '완료',
  thinking_start: '생각',
  thinking_delta: '생각',
  thinking_end: '생각',
  tool_start: '도구',
  tool_result: '도구 결과',
};

const SOURCE_LABELS: Partial<Record<SearchMatchSource, string>> = {
  turn_summary: '턴 요약',
  highlight: '하이라이트',
  story: '줄거리',
};

export function SearchResultMessageRow({
  sessionTitle,
  eventType,
  matchSource,
  preview,
  query,
  selected = false,
  onPress,
}: {
  sessionTitle: string;
  eventType: string;
  matchSource: SearchMatchSource;
  preview: string;
  query: string;
  selected?: boolean;
  onPress(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const label = SOURCE_LABELS[matchSource]
    ?? EVENT_LABELS[eventType]
    ?? eventType.replaceAll('_', ' ');
  return (
    <AppGlassPressable
      testID="search-message-result"
      accessibilityLabel={`대화 내용 결과, ${sessionTitle}, ${label}, ${preview}`}
      role={selected ? 'glassDense' : 'glassCard'}
      style={selected ? styles.selected : undefined}
      contentStyle={styles.row}
      onPress={onPress}
    >
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{sessionTitle}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      </View>
      <HighlightedSnippet text={preview} query={query} styles={styles} />
    </AppGlassPressable>
  );
}

function HighlightedSnippet({
  text,
  query,
  styles,
}: {
  text: string;
  query: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  const parts = highlightParts(text, query);
  return (
    <Text style={styles.preview} numberOfLines={4}>
      {parts.map((part, index) => (
        <Text
          key={`${index}:${part.text}`}
          style={part.highlighted ? [styles.preview, styles.highlight] : styles.preview}
        >
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

export function highlightParts(
  text: string,
  query: string,
): Array<{ text: string; highlighted: boolean }> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, highlighted: false }];
  const lower = text.toLocaleLowerCase();
  const result: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) {
      result.push({ text: text.slice(cursor), highlighted: false });
      break;
    }
    if (index > cursor) {
      result.push({ text: text.slice(cursor, index), highlighted: false });
    }
    result.push({
      text: text.slice(index, index + needle.length),
      highlighted: true,
    });
    cursor = index + needle.length;
  }
  return result.length > 0 ? result : [{ text, highlighted: false }];
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    selected: {
      borderWidth: 1,
      borderColor: t.colors.accent,
    },
    row: {
      minHeight: t.foundation.minHeight.row,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      gap: t.spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    title: {
      flex: 1,
      color: t.colors.textPrimary,
      ...t.foundation.typography.cardTitle,
    },
    badge: {
      minHeight: 24,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radius.lg,
      backgroundColor: t.colors.border,
    },
    badgeText: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.label,
    },
    preview: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.body,
    },
    highlight: {
      color: t.colors.textPrimary,
      fontWeight: '700',
      backgroundColor: t.colors.accentTint,
    },
  });
}
