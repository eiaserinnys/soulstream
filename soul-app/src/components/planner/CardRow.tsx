import {cardExecutionState,subscribeCardWrites} from '../../lib/card-transition';
import React, { useMemo, useSyncExternalStore } from 'react';
import { Image, Text, Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { CARD_STATUS_LABEL } from '../../lib/card-presentation';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { decodeAuthJwt } from '../../auth/jwt-payload';
import { useTokens } from '../../theme';
import type { ColorScheme } from '../../theme/colors';
import { GlassButton } from '../GlassSurface';
import { makeSessionCardStyles } from '../sessionCardFrame';
import { AppGlassCard } from '../AppGlassCard';
import { useCardDetail } from '../../hooks/useCardDetail';
import { resolveSessionModelLabel } from '../sessionCardDisplay';
import { resolveSessionAgentLabel, resolveSessionCardAvatar } from '../sessionCardDisplay';
import { formatRelativeTime } from '../../lib/relative-time';
import { CardRequestView } from './CardRequestView';
import { CardReportView } from './CardReportView';
import { cardItemDisplayColor, EMPTY_PENDING_ITEM_CONFIRMATIONS, summarizeCardItems } from '../../lib/card-check-item-summary';
import { useCardStore } from '../../store/cardStore';
import { withAlphaColor } from '../StatusPulseDecoration';

export function CardStatusChip({ card, title = false, board = false, detail = false, colors }: { card: CardDto; title?: boolean; board?: boolean; detail?: boolean; colors?: ColorScheme }) {
  const t = useTokens();
  const execution = useSyncExternalStore(subscribeCardWrites, () => cardExecutionState(card.id), () => undefined);
  const palette = colors ?? t.colors;
  const color = colors ? card.status === 'review' ? palette.link : card.status === 'running' ? palette.successText
    : card.status === 'blocked' ? palette.warningText : palette.textMuted
    : card.status === 'review' ? t.colors.accent : card.status === 'running' ? t.colors.success
    : card.status === 'blocked' ? t.colors.warning : t.colors.textMuted;
  const capsuleColor = card.status === 'running' ? t.colors.statusRunning : card.status === 'review' || card.status === 'done'
    ? t.colors.statusCompleted : card.status === 'blocked' ? t.colors.warning : t.colors.statusIdle;
  return <Text style={{ ...t.foundation.typography.meta, color,
    ...(title ? { ...t.foundation.typography.cardTitle, marginRight: t.uiSpacing.sm } : {}),
    ...(detail ? { backgroundColor: withAlphaColor(capsuleColor, 0.12), borderRadius: t.foundation.radius.chip,
      paddingHorizontal: t.uiSpacing.xs, paddingVertical: t.uiSpacing.xxs, marginRight: t.uiSpacing.xs } : {}),
    fontWeight: '700' }} numberOfLines={1}>
    {execution?.phase === 'pending' ? '시작 중…' : board && card.status === 'todo' ? '드래프트' : board && card.status === 'review' ? '검수 대기'
      : card.status === 'blocked' && card.blockedKind === 'question' ? (board ? '막힘 · 질문' : '질문') : CARD_STATUS_LABEL[card.status]}
  </Text>;
}

export function CardRow({ api, card, onOpen, today, queueIndex, board = false }: {
  api: ApiClient | null; card: CardDto; onOpen(): void; today?: boolean; queueIndex?: number; board?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeSessionCardStyles(t, true), [t]);
  const { detail } = useCardDetail(api, board ? null : card.id);
  const pendingItemConfirmations = useCardStore((state) => state.pendingItemConfirmations[card.id] ?? EMPTY_PENDING_ITEM_CONFIRMATIONS);
  const folders = useSessionStore((state) => state.catalog.folders);
  const assigned = useSessionStore((state) => card.assigneeSessionId ? state.sessions[card.assigneeSessionId] : undefined);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const profile = useMemo(() => decodeAuthJwt(jwt), [jwt]);
  const itemSummary = useMemo(() => summarizeCardItems(card.items, pendingItemConfirmations), [card.items, pendingItemConfirmations]);
  const agentId = assigned?.agentId ?? card.assigneeAgentId;
  const nodeId = assigned?.nodeId ?? card.nodeId;
  const identity = { agentSessionId: card.assigneeSessionId ?? card.id, agentId, agentName: assigned?.agentName,
    agentPortraitUrl: assigned?.agentPortraitUrl ?? (agentId && nodeId ? `/api/nodes/${nodeId}/agents/${agentId}/portrait` : null) };
  const avatar = resolveSessionCardAvatar(identity, serverUrl);
  const human = card.assigneeKind === 'human';
  const uri = human ? profile?.picture : avatar.uri;
  const assignee = human ? card.assigneeUserId ?? profile?.name ?? '사용자' : agentId ? resolveSessionAgentLabel(identity) : '담당 미지정';
  const model = resolveSessionModelLabel(assigned ?? {}) ?? assigned?.modelPreset ?? card.modelPreset ?? '기본 모델';
  const metadata = [today ? folders.find((folder) => folder.id === card.folderId)?.name : null,
    assignee, nodeId, model].filter(Boolean).join(' · ');
  const report = detail?.reports.reduce((latest, item) => !latest || item.createdAt >= latest.createdAt ? item : latest, undefined as typeof detail.reports[number] | undefined);
  const comment = detail?.comments?.reduce((latest, item) => !latest || item.createdAt >= latest.createdAt ? item : latest, undefined as NonNullable<typeof detail.comments>[number] | undefined);
  const preview = (card.now?.text || report?.title || comment?.body || card.request).split('\n')[0];
  const { transition, pending } = useCardTransition(api, card.id);
  const time = <Text style={styles.time} numberOfLines={1}>{formatRelativeTime(card.updatedAt)}</Text>;
  const complete = card.status === 'review' ? <GlassButton iconOnly size={board ? 'compact' : 'card'} borderRadius={t.foundation.radius.round} accessibilityLabel="완료"
    disabled={pending || !api} surfaceTestID={`card-${card.id}-완료-visual`} onPress={() => {
      void transition(card, 'done');
    }}><Ionicons name="checkmark" size={t.iconSize.standard} color={t.colors.textSecondary} /></GlassButton> : null;
  const identityContent = <>
      {uri ? <Image testID={`card-${card.id}-avatar`} source={{ uri, ...(jwt && uri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }} style={styles.avatar} />
        : <View testID={`card-${card.id}-avatar`} style={[styles.avatar, styles.avatarFallback]}><Text style={styles.avatarFallbackText}>{human ? assignee[0] : avatar.fallbackChar}</Text></View>}
      <View style={styles.content}>
        <View style={styles.primaryColumn}>
          <View style={styles.titleRow}>{board ? null : <CardStatusChip card={card} title />}<Text testID={board ? `card-${card.id}-board-title` : undefined} style={styles.name} numberOfLines={1}>{card.title}</Text></View>
          <View style={[styles.identityRow, board && { minHeight: t.hitTarget.min }]}>
            <Text style={[styles.identity, board && { flex: 1 }]} numberOfLines={1}>{metadata}</Text>
            {itemSummary.total ? <CardItemSummary card={card} summary={itemSummary} /> : null}
            {board ? <View testID={`card-${card.id}-board-actions`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
              {time}{complete}
            </View> : null}
          </View>
          <View style={styles.contextRow}>{board ? <CardStatusChip card={card} board /> : <Text testID={`card-${card.id}-preview`} style={styles.context} numberOfLines={1}>{preview}</Text>}</View>
          {!board && card.now?.turn === 'user' ? <Text testID={`card-${card.id}-ask-preview`} style={styles.context} numberOfLines={1}>
            {`볼 것 ${itemSummary.needsReview}${card.now.ask ? ` · ${card.now.ask}` : ''}`}
          </Text> : null}
        </View>
        {board ? null : <View style={styles.rightRail}>{complete}{time}</View>}
      </View>
  </>;
  return <AppGlassCard testID={`card-row-${card.id}`} style={styles.cardSurface} isInteractive>
    <Pressable testID={`card-row-${card.id}-layout`} style={board ? undefined : styles.card} onPress={onOpen} accessibilityLabel={`${card.title} 카드 상세`}>
      {board ? <>
        <View style={styles.card}>{identityContent}</View>
        <View testID={`card-${card.id}-board-body`} style={{ paddingHorizontal: styles.card.paddingHorizontal, paddingBottom: styles.card.paddingVertical, gap: t.uiSpacing.md }}>
          <CardRequestView request={card.request} attachments={card.attachments} />
          {card.now ? <Text testID={`card-${card.id}-now-preview`} style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }} numberOfLines={1}>{card.now.text}</Text>
            : card.latestActivity ? <View style={{ gap: t.uiSpacing.xs }}>
            <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{card.latestActivity.kind === 'report' ? '최신 보고' : '최신 지시'}</Text>
            {card.latestActivity.format === 'html' ? <CardReportView report={{ ...card.latestActivity, id: `${card.id}-activity`, cardId: card.id, title: '' }} />
              : <CardRequestView request={card.latestActivity.body} />}
          </View> : null}
          {card.now?.turn === 'user' ? <Text testID={`card-${card.id}-board-ask-preview`} style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }} numberOfLines={1}>
            {`볼 것 ${itemSummary.needsReview}${card.now.ask ? ` · ${card.now.ask}` : ''}`}
          </Text> : null}
        </View>
      </> : identityContent}
    </Pressable>
  </AppGlassCard>;
}

function CardItemSummary({ card, summary }: { card: CardDto; summary: ReturnType<typeof summarizeCardItems> }) {
  const t = useTokens();
  return <View testID={`card-${card.id}-item-summary`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs }}>
    {summary.unconfirmed.map((item) => <View key={item.id} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width: t.uiSpacing.xxs, height: t.uiSpacing.xxs, borderRadius: t.foundation.radius.round,
        backgroundColor: cardItemDisplayColor(item.display, t.colors) }} />)}
    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{summary.confirmed}/{summary.total} 확인</Text>
    {summary.needsReview > 0 ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.statusCompleted }}>볼 것 {summary.needsReview}</Text> : null}
  </View>;
}
