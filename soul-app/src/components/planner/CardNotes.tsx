import React, { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { CardComment } from '../../api/cardTypes';
import type { Session } from '../../api/types';
import { formatCardTime } from '../../lib/card-check-item-summary';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { resolveSessionCardAvatar, resolveSessionAgentLabel } from '../sessionCardDisplay';
import { useTokens, type DesignTokens } from '../../theme';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { PlannerMarkdownText } from './PlannerMarkdownText';

export function CardNotes({ brief, notes, sessions, assigneeSessionId }: {
  assigneeSessionId?: string | null;
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
            <NoteMessage key={note.id} note={note} sessions={sessions} assigneeSessionId={assigneeSessionId} />
          )) : null}
        </View>
      ) : null}
      {recent.map((note) => <NoteMessage key={note.id} note={note} sessions={sessions} assigneeSessionId={assigneeSessionId} />)}
    </View>
  );
}

function NoteMessage({ note, sessions, assigneeSessionId }: { note: CardComment; sessions: Session[]; assigneeSessionId?: string | null }) {
  const t = useTokens();
  const styles = useMemo(() => makeNoteStyles(t), [t]);
  const author = sessions.find((session) => session.agentSessionId === note.sessionId)
    ?? { agentSessionId: note.sessionId ?? note.authorId ?? note.cardId, agentId: note.authorId };
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const avatar = resolveSessionCardAvatar(author, serverUrl);
  return <View testID={`card-note-${note.id}`} style={styles.record}>
    <View style={styles.recordRow}>
      {avatar.uri ? <Image source={{ uri: avatar.uri, ...(jwt && avatar.uri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }} style={styles.avatar} />
        : <View style={[styles.avatar, styles.avatarFallback]}><Text style={styles.name}>{avatar.fallbackChar}</Text></View>}
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>{resolveSessionAgentLabel(author)}</Text>
          {assigneeSessionId && note.sessionId === assigneeSessionId ? <Text style={styles.owner}>담당</Text> : null}
          <Text style={styles.time}>{formatCardTime(note.createdAt)}</Text>
        </View>
        <PlannerMarkdownText markdown={note.body} variant="note" />
      </View>
    </View>
  </View>;
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: { gap: t.uiSpacing.md },
    brief: { gap: t.uiSpacing.sm },
    sectionTitle: { ...t.foundation.typography.section, color: t.colors.textPrimary },
  });
}

function makeNoteStyles(t: DesignTokens) {
  return StyleSheet.create({
    record: { paddingBottom: t.uiSpacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border },
    recordRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.uiSpacing.sm },
    content: { flex: 1, minWidth: 0, gap: t.uiSpacing.xxs },
    header: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm },
    avatar: { width: t.avatarSize.message, height: t.avatarSize.message, borderRadius: t.foundation.radius.round },
    avatarFallback: { backgroundColor: t.colors.surfaceCode, alignItems: 'center', justifyContent: 'center' },
    name: { ...t.foundation.typography.meta, color: t.colors.textSecondary, fontWeight: '700', flexShrink: 1 },
    owner: { ...t.foundation.typography.meta, fontWeight: '500', color: t.colors.textMuted },
    time: { ...t.foundation.typography.meta, fontWeight: '500', color: t.colors.textMuted, marginLeft: 'auto' },
  });
}
