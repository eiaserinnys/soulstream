import {CardTransitionSettings} from './CardTransitionSettings';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDetail, CardDto, CardStatus } from '../../api/cardTypes';
import { captureAuthScope } from '../../lib/auth-scope';
import { BOARD_COLUMNS } from '../../lib/card-board-layout';
import { cardTransitionProblem } from '../../lib/card-transition';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useTokens } from '../../theme';
import { CARD_COLOR_KEYS, CARD_COLORS, type CardColor } from '../../../../packages/wire-schema/src/card_colors';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { cardStyles } from './Card.styles';
import { GroupedGlassRow, GroupedGlassSheet } from './GroupedGlassSheet';
import Ionicons from '@expo/vector-icons/Ionicons';

export function CardStatusMenu({ api, card, onClose }: {
  api: ApiClient | null; card: CardDto; onClose(): void;
}) {
  const t = useTokens();
  const styles = cardStyles(t);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [colorSelection, setColorSelection] = useState(false);
  const active = useRef(true);
  const action=useCardTransition(api,card.id);
  const { transition, pending, error }=action;
  const colorAction = useCardActions(api, cause => setReadError(cause instanceof Error ? cause.message : String(cause)));
  const mutationPending = pending || colorAction.pending;
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
  const chooseColor = async (color: CardColor) => {
    if (!detail || !api || !active.current) return;
    if ((detail.card.color ?? 'yellow') === color) { onClose(); return; }
    setReadError(null);
    const ok = await colorAction.run(() => api.updateCard(card.id, { color }, detail.card.version, cardOperationId()));
    if (ok && active.current) onClose();
  };
  const currentColor = detail?.card.color ?? 'yellow';
  const visibleError = readError ?? error;
  return <><CardTransitionSettings api={api} action={action} onExecuted={onClose}/><AppModalSurface visible={!action.settingsCard} modalId="modal_card_assignment" variant="compact" onRequestClose={() => { active.current = false; onClose(); }}>
    <ScrollView testID="card-status-menu" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text style={styles.heading} numberOfLines={2}>{card.title} · {colorSelection ? '카드 색상' : '상태 이동'}</Text>
      {!detail && !readError ? <ActivityIndicator color={t.colors.accent} /> : null}
      {action.execution && action.execution.phase !== 'pending' ? <><Text style={styles.error}>{action.execution.message}</Text><GlassButton disabled={pending} onPress={() => { void move('running'); }}><Text style={styles.body}>{action.execution.phase === 'delayed' ? '다시 확인' : '다시 시도'}</Text></GlassButton></> : null}
      {visibleError ? <Text accessibilityRole="alert" style={styles.error}>{visibleError}</Text> : null}
      {readError || error ? <GlassButton accessibilityLabel="카드 다시 조회" onPress={() => { void read(); }}><Text style={styles.body}>다시 조회</Text></GlassButton> : null}
      {colorSelection ? <>
        {colorAction.pending ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
          <ActivityIndicator color={t.colors.accent} /><Text style={styles.body}>색상을 저장하는 중…</Text>
        </View> : null}
        {detail ? <GroupedGlassSheet testID="card-color-selection">
          {CARD_COLOR_KEYS.map(color => <GroupedGlassRow key={color} compact testID={`card-color-option-${color}`}
            accessibilityLabel={CARD_COLORS[color].name} selected={color === currentColor} disabled={mutationPending}
            style={{ paddingHorizontal: t.cardLayout.padding, gap: t.uiSpacing.xs, flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { void chooseColor(color); }}>
            <Text style={[styles.body, { flex: 1 }]}>{CARD_COLORS[color].name}</Text>
            {color === currentColor ? <Ionicons name="checkmark" size={t.iconSize.standard} color={t.colors.accent} /> : null}
          </GroupedGlassRow>)}
        </GroupedGlassSheet> : null}
        <GlassButton testID="card-color-back" accessibilityLabel="색상 선택 뒤로" disabled={colorAction.pending}
          onPress={() => { setColorSelection(false); setReadError(null); }}><Text style={styles.body}>돌아가기</Text></GlassButton>
      </> : <>
        {detail ? <GlassButton accessibilityLabel={`카드 색상: ${CARD_COLORS[currentColor].name}`} disabled={mutationPending}
          onPress={() => setColorSelection(true)}><Text style={styles.body}>카드 색상: {CARD_COLORS[currentColor].name}</Text></GlassButton> : null}
        {detail ? BOARD_COLUMNS.map(([next, label]) => {
          const problem = cardTransitionProblem(detail, next);
          return <View key={next} style={{ gap: t.uiSpacing.xs }}>
            <GlassButton accessibilityLabel={`${label}로 이동`} disabled={mutationPending || !!problem} onPress={() => { void move(next); }}>
              <Text style={styles.body}>{label}</Text>
            </GlassButton>
          </View>;
        }) : null}
        <GlassButton accessibilityLabel="상태 메뉴 닫기" onPress={() => { active.current = false; onClose(); }}><Text style={styles.body}>닫기</Text></GlassButton>
      </>}
    </ScrollView>
  </AppModalSurface></>;
}
