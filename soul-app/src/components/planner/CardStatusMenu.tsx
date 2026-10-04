import {CardTransitionSettings} from './CardTransitionSettings';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
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

export function CardStatusMenu({ api, card, onClose }: {
  api: ApiClient | null; card: CardDto; onClose(): void;
}) {
  const t = useTokens();
  const styles = cardStyles(t);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const active = useRef(true);
  const action=useCardTransition(api,card.id);
  const { transition, pending, error }=action;
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
    const ok = await transition(detail.card, next, undefined, () => active.current);
    if (ok && active.current) onClose();
  };
  return <><CardTransitionSettings api={api} action={action} onExecuted={onClose}/><AppModalSurface visible={!action.settingsCard} modalId="modal_card_assignment" variant="compact" onRequestClose={() => { active.current = false; onClose(); }}>
    <ScrollView testID="card-status-menu" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text style={styles.heading} numberOfLines={2}>{card.title} · 상태 이동</Text>
      {!detail && !readError ? <ActivityIndicator color={t.colors.accent} /> : null}
      {readError || error ? <Text accessibilityRole="alert" style={styles.error}>{readError ?? error}</Text> : null}
      {readError || error ? <GlassButton accessibilityLabel="상태 다시 조회" onPress={() => { void read(); }}><Text style={styles.body}>다시 조회</Text></GlassButton> : null}
      {detail ? ([...BOARD_COLUMNS, ['cancelled', '취소']] as const).map(([next, label]) => {
        const problem = cardTransitionProblem(detail, next);
        return <View key={next} style={{ gap: t.uiSpacing.xs }}>
          <GlassButton accessibilityLabel={`${label}로 이동`} disabled={pending || !!problem} onPress={() => { void move(next); }}>
            <Text style={styles.body}>{label}</Text>
          </GlassButton>
        </View>;
      }) : null}
      <GlassButton accessibilityLabel="상태 메뉴 닫기" onPress={() => { active.current = false; onClose(); }}><Text style={styles.body}>닫기</Text></GlassButton>
    </ScrollView>
  </AppModalSurface></>;
}
