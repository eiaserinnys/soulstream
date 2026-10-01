import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDetail, CardDto, CardStatus } from '../../api/cardTypes';
import { captureAuthScope } from '../../lib/auth-scope';
import { BOARD_COLUMNS } from '../../lib/card-board-layout';
import { cardTransitionProblem } from '../../lib/card-transition';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { cardStyles } from './Card.styles';

export function CardStatusMenu({ api, card, initialTarget, onClose }: {
  api: ApiClient | null; card: CardDto; initialTarget?: CardStatus; onClose(): void;
}) {
  const t = useTokens();
  const styles = cardStyles(t);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [target, setTarget] = useState<CardStatus | undefined>(initialTarget);
  const [reason, setReason] = useState('');
  const active = useRef(true);
  const { transition, pending, error } = useCardTransition(api, card.id);
  const read = async () => {
    if (!api) return;
    const scope = captureAuthScope().generation;
    setReadError(null);
    try { const next = await api.getCard(card.id); if (active.current && scope === captureAuthScope().generation) setDetail(next); }
    catch (cause) { if (active.current && scope === captureAuthScope().generation) setReadError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { active.current = true; void read(); return () => { active.current = false; }; }, [api, card.id]);
  const move = async (next: CardStatus) => {
    if (!detail || !active.current) return;
    if (detail.card.status === 'review' && next === 'running' && !reason.trim()) { setTarget(next); return; }
    const ok = await transition(detail.card, next, reason, () => active.current);
    if (ok && active.current) onClose();
  };
  return <AppModalSurface visible modalId="modal_card_assignment" variant="compact" onRequestClose={() => { active.current = false; onClose(); }}>
    <ScrollView testID="card-status-menu" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text style={styles.heading} numberOfLines={2}>{card.title} · 상태 이동</Text>
      {!detail && !readError ? <ActivityIndicator color={t.colors.accent} /> : null}
      {readError || error ? <Text accessibilityRole="alert" style={styles.error}>{readError ?? error}</Text> : null}
      {readError || error ? <GlassButton accessibilityLabel="상태 다시 조회" onPress={() => { void read(); }}><Text style={styles.body}>다시 조회</Text></GlassButton> : null}
      {detail ? BOARD_COLUMNS.map(([next, label]) => {
        const needsReason = detail.card.status === 'review' && next === 'running';
        const problem = cardTransitionProblem(detail, next, needsReason ? reason || '사유 입력 예정' : undefined);
        return <View key={next} style={{ gap: t.uiSpacing.xs }}>
          <GlassButton accessibilityLabel={`${label}로 이동`} disabled={pending || !!problem} onPress={() => { void move(next); }}>
            <Text style={styles.body}>{label}{detail.card.status === next ? ' · 현재' : ''}</Text>
          </GlassButton>
          {problem && detail.card.status !== next ? <Text style={styles.body}>{problem}</Text> : null}
        </View>;
      }) : null}
      {target === 'running' && detail?.card.status === 'review' ? <View style={{ gap: t.uiSpacing.sm }}>
        <Text style={styles.body}>재실행 사유</Text>
        <TextInput accessibilityLabel="재실행 사유" value={reason} onChangeText={setReason} multiline editable={!pending} style={styles.input} />
        <GlassButton accessibilityLabel="사유와 함께 실행 중으로 이동" disabled={pending || !reason.trim()} onPress={() => { void move('running'); }}><Text style={styles.body}>이동</Text></GlassButton>
      </View> : null}
      <GlassButton accessibilityLabel="상태 메뉴 닫기" onPress={() => { active.current = false; onClose(); }}><Text style={styles.body}>닫기</Text></GlassButton>
    </ScrollView>
  </AppModalSurface>;
}
