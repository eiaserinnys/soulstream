import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CardComment } from '../../api/cardTypes';
import type { Session } from '../../api/types';
import { formatRelativeTime } from '../../lib/relative-time';
import { useTokens, type DesignTokens } from '../../theme';
import { AssistantMessage } from '../events/AssistantMessage';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { PlannerMarkdownText } from './PlannerMarkdownText';

export function CardNotes({ brief, notes, sessions }: {
  brief: string;
  notes: CardComment[];
  sessions: Session[];
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [olderExpanded, setOlderExpanded] = useState(false);
  const ordered = useMemo(() => [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [notes]);
  const splitAt = Math.max(0, ordered.length - 5);
  const older = ordered.slice(0, splitAt);
  const recent = ordered.slice(splitAt);

  return (
    <View testID="card-notes" style={styles.container}>
      <View style={styles.brief}>
        <Text style={styles.sectionTitle}>인계 요약</Text>
        <PlannerMarkdownText markdown={brief || '아직 경과가 없습니다.'} variant="card" />
      </View>
      {older.length ? (
        <View>
          <PlannerSectionHeader
            title={`앞선 노트 ${older.length}건`}
            variant="compact"
            expanded={olderExpanded}
            onToggle={() => setOlderExpanded((value) => !value)}
          />
          {olderExpanded ? older.map((note) => (
            <NoteMessage key={note.id} note={note} sessions={sessions} />
          )) : null}
        </View>
      ) : null}
      {recent.map((note) => <NoteMessage key={note.id} note={note} sessions={sessions} />)}
    </View>
  );
}

function NoteMessage({ note, sessions }: { note: CardComment; sessions: Session[] }) {
  const t = useTokens();
  const styles = useMemo(() => makeNoteStyles(t), [t]);
  const author = sessions.find((session) => session.agentSessionId === note.sessionId);
  const event = { id: note.id, type: 'assistant_message' as const, data: { text: note.body } };
  return (
    <AssistantMessage
      event={event}
      session={author ? {
        agentName: author.agentName,
        agentPortraitUrl: author.agentPortraitUrl,
        displayName: author.displayName,
      } : undefined}
      bubbleWidth="fill"
      messageKind={<View style={styles.header}><Text style={styles.label}>노트</Text><Text style={styles.time}>{formatRelativeTime(note.createdAt)}</Text></View>}
    />
  );
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  return StyleSheet.create({
    container: { gap: t.uiSpacing.md },
    brief: { gap: t.uiSpacing.sm },
    sectionTitle: { ...type.section, color: t.colors.textPrimary },
  });
}

function makeNoteStyles(t: DesignTokens) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, marginBottom: t.uiSpacing.xs },
    label: { ...t.foundation.typography.meta, color: t.colors.accent, fontWeight: '700' },
    time: { ...t.foundation.typography.meta, color: t.colors.textMuted },
  });
}
