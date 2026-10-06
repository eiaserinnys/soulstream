import {CardTransitionSettings} from './CardTransitionSettings';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiClient } from '../../api/client';
import type { CardCheckItem, CardDto, CardStatus } from '../../api/cardTypes';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useCardComments } from '../../hooks/useCardComments';
import { useCardDetail } from '../../hooks/useCardDetail';
import { useCardItems } from '../../hooks/useCardItems';
import { useUIStore } from '../../store/uiStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { decodeAuthJwt } from '../../auth/jwt-payload';
import { resolveSessionCardAvatar, resolveSessionAgentLabel } from '../sessionCardDisplay';
import { useDeviceType, useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { NavigationContext } from '@react-navigation/native';
import { CardCommentComposer, type CardCommentComposerHandle } from './CardCommentComposer';
import { makeFolderWorkspaceStyles } from './FolderWorkspace.styles';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { FolderSessionHistory } from './FolderSessionHistory';
import { CardAssignmentSheet } from './CardAssignmentSheet';
import { CardStatusChip } from './CardRow';
import { CardStatusMenu } from './CardStatusMenu';
import { CardTimeline } from './CardTimeline';
import { cardDetailStyles } from './CardDetail.styles';
import { CardCheckItems } from './CardCheckItems';
import { CardNowPanel } from './CardNowPanel';
import { CardNotes } from './CardNotes';
import { CardRequestView } from './CardRequestView';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { resolveTabletBottomSafeAreaPadding } from '../split/tabletShellInsets';
import { summarizeCardItems } from '../../lib/card-check-item-summary';

type CardDetailTab = 'items' | 'comments' | 'sessions' | 'notes';
type CardDetailVisitState = {
  cardId: string;
  initialTab: CardDetailTab;
  initiallyConfirmedIds: number[];
  newlyConfirmedIds: number[];
};

type CardDetailContentProps = {
  api: ApiClient | null;
  cardId: string;
  onClose(): void;
  onOpenSession?(id: string): void;
  inline?: boolean;
} & (
  | { variant?: 'default'; onOpenCard?: never }
  | { variant: 'readSummary'; onOpenCard(): void }
);

export function CardDetailSheet({ api, cardId, onClose, onOpenSession }: {
  api: ApiClient | null; cardId: string | null; onClose(): void; onOpenSession?(id: string): void;
}) {
  const tablet = useDeviceType() !== 'phone';
  const navigation = React.useContext(NavigationContext);
  useEffect(() => {
    if (!cardId) return;
    if (tablet) useUIStore.getState().openCardOverlay(cardId);
    else navigation?.navigate('CardDetail', { cardId });
    onClose();
  }, [tablet, cardId, navigation, onClose]);
  return null;
}

export function CardDetailContent(props: CardDetailContentProps) {
  const { api, cardId, onClose, onOpenSession, inline = false } = props;
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const folderStyles = useMemo(() => makeFolderWorkspaceStyles(t), [t]);
  const { detail, error } = useCardDetail(api, cardId);
  const { run, pending } = useCardActions(api);
  const itemActions = useCardItems(api, cardId);
  const statusAction = useCardTransition(api, cardId);
  const comments = useCardComments(api, cardId);
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const tablet = inline || useDeviceType() !== 'phone';
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const composer = useRef<CardCommentComposerHandle>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const chooseAnswer = React.useCallback((answer: string) => composer.current?.chooseAnswer(answer), []);
  const scroll = useRef<ScrollView>(null);
  const [frameWidth, setFrameWidth] = useState(windowWidth);
  const [dockHeight, setDockHeight] = useState(0);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [tabChoice, setTabChoice] = useState<{ cardId: string; value: CardDetailTab } | null>(null);
  const [visitState, setVisitState] = useState<CardDetailVisitState | null>(null);
  const [targetChoice, setTargetChoice] = useState<{ cardId: string; item: CardCheckItem } | null>(null);
  const [unreadChoice, setUnreadChoice] = useState<{ cardId: string; value: boolean } | null>(null);
  const [noticeChoice, setNoticeChoice] = useState<{ cardId: string; value: boolean } | null>(null);
  const assignmentAttempt=useRef<{key:string;value:string}|null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const card = detail?.card;
  const cardItems = itemActions.items;
  const firstVisit = detail?.card.id === cardId ? {
    cardId,
    initialTab: (detail.card.items?.length ?? 0) > 0 ? 'items' as const : 'comments' as const,
    initiallyConfirmedIds: (detail.card.items ?? []).filter((item) => item.display === 'confirmed').map((item) => item.id),
    newlyConfirmedIds: [],
  } : null;
  if (firstVisit && visitState?.cardId !== cardId) setVisitState(firstVisit);
  const currentVisit = visitState?.cardId === cardId ? visitState : firstVisit;
  const initialTab = currentVisit?.initialTab ?? 'comments';
  const tab = tabChoice?.cardId === cardId ? tabChoice.value : initialTab;
  const itemSummary = useMemo(() => summarizeCardItems(cardItems, itemActions.pendingConfirmations),
    [cardItems, itemActions.pendingConfirmations]);
  const targetItem = targetChoice?.cardId === cardId ? targetChoice.item : null;
  const commentUnread = unreadChoice?.cardId === cardId && unreadChoice.value;
  const sendNotice = noticeChoice?.cardId === cardId && noticeChoice.value;
  const allConfirmed = itemSummary.total > 0 && itemSummary.unconfirmed.length === 0;
  const needsReview = itemSummary.needsReview;
  const tabletLandscape = tablet && windowWidth > windowHeight;
  const startable = card?.status === 'todo' || card?.status === 'queued';
  const startPhase = statusAction.execution?.phase;
  const actionLabel = startPhase === 'pending' ? '시작 중…' : startPhase ? (startPhase === 'delayed' ? '다시 확인' : '다시 시도') : startable ? '시작하기' : '완료';
  const timelineStamp = detail ? `${detail.questions.length}:${detail.reports.length}:${detail.comments?.filter((comment) => comment.kind !== 'note').length ?? 0}` : '';
  const scrollStamp = useRef('');
  const assigned = useSessionStore((state) => card?.assigneeSessionId ? state.sessions[card.assigneeSessionId] : undefined)
    ?? detail?.sessions.find((session) => session.agentSessionId === card?.assigneeSessionId);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const agent = assigned ?? { agentSessionId: card?.assigneeKind === 'session' && card.assigneeSessionId ? card.assigneeSessionId : card?.id ?? '',
    agentId: card?.assigneeAgentId, agentPortraitUrl: null };
  const nodeId = assigned?.nodeId ?? card?.nodeId;
  const identity = { ...agent, agentPortraitUrl: agent.agentPortraitUrl ?? (agent.agentId && nodeId ? `/api/nodes/${nodeId}/agents/${agent.agentId}/portrait` : null) };
  const avatar = resolveSessionCardAvatar(identity, serverUrl);
  const locked = pending || statusAction.pending || comments.pending || composerBusy;
  const question = [...(detail?.questions ?? [])].reverse().find(item => item.answer === null);
  const dockBottom = keyboardOverlap > 0
    ? t.uiSpacing.sm
    : tablet
      ? resolveTabletBottomSafeAreaPadding(insets.bottom, t.tabletShell.outerInset) + t.uiSpacing.sm
      : insets.bottom + t.uiSpacing.sm;
  const setTab = (next: CardDetailTab) => {
    setTabChoice({ cardId, value: next });
    if (next === 'comments') {
      setUnreadChoice({ cardId, value: false });
      setNoticeChoice({ cardId, value: false });
    }
  };
  const setItemTarget = (item: CardCheckItem) => {
    setTargetChoice({ cardId, item });
    requestAnimationFrame(() => composer.current?.focus());
  };
  const setRecentConfirmation = (itemId: number, confirmed: boolean) => {
    setVisitState((current) => {
      if (current?.cardId !== cardId) return current;
      const exists = current.newlyConfirmedIds.includes(itemId);
      if (exists === confirmed) return current;
      return {
        ...current,
        newlyConfirmedIds: confirmed
          ? [...current.newlyConfirmedIds, itemId]
          : current.newlyConfirmedIds.filter((id) => id !== itemId),
      };
    });
  };
  const onOverlapChange = useCallback((overlap: number) => setKeyboardOverlap(overlap), []);
  useEffect(() => {
    if (!sendNotice) return;
    const timeout = setTimeout(() => setNoticeChoice((current) => current?.cardId === cardId ? { cardId, value: false } : current), 6000);
    return () => clearTimeout(timeout);
  }, [cardId, sendNotice]);
  useEffect(() => {
    if (!detail || detail.card.id !== cardId) return;
    if (tab !== 'comments') {
      requestAnimationFrame(() => scroll.current?.scrollTo({ y: 0, animated: false }));
      return;
    }
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
  }, [cardId, tab, detail?.card.id]);
  const status = async (next: CardStatus, reason?: string) => {
    if (!api || !card) return Promise.resolve(false);
    const ok = await statusAction.transition(card, next, reason);
    if (ok && next === 'done' && active.current) onClose();
    return ok;
  };
  const openSession = (id: string) => {
    if (!inline) onClose();
    if (onOpenSession) onOpenSession(id);
    else useUIStore.getState().openSessionAtEvent(id);
  };
  const sessionSummaries = useMemo(() => (detail?.sessions ?? []).map((session) => ({
    ...session,
    folderId: session.folderId ?? null, displayName: session.displayName ?? null,
    nodeId: session.nodeId ?? null, sessionType: session.sessionType ?? null,
    agentId: session.agentId ?? null, predecessorSessionId: null,
    reviewState: session.reviewState ?? 'not_required',
  })), [detail?.sessions]);
  const sessionIds = [...new Set([...(card?.assigneeSessionId ? [card.assigneeSessionId] : []), ...(detail?.sessions ?? []).map((session) => session.agentSessionId)])];
  const tabOptions = [
    { value: 'items' as const, label: '확인 항목', count: needsReview || undefined, countBadge: true },
    { value: 'comments' as const, label: '커멘트', dot: commentUnread },
    { value: 'sessions' as const, label: '세션', count: tabletLandscape ? sessionIds.length : undefined },
    { value: 'notes' as const, label: '노트', count: tabletLandscape ? (detail?.notes?.length ?? 0) : undefined },
  ];
  const selectedItem = targetItem;
  if (props.variant === 'readSummary') return <CardReadSummary card={card} items={cardItems} error={error}
    assigneeLabel={card?.assigneeKind === 'human' ? card.assigneeUserId ?? '사용자'
      : card?.assigneeKind === 'session' ? assigned?.displayName?.trim() || resolveSessionAgentLabel(identity)
        : card?.assigneeKind === 'agent' ? resolveSessionAgentLabel(identity) : null}
    hasAssignee={card?.assigneeKind != null} human={card?.assigneeKind === 'human'} avatar={avatar} onOpenCard={props.onOpenCard} />;
  return <><AppKeyboardAvoidingView testID="card-detail-container" behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    onOverlapChange={onOverlapChange} style={folderStyles.container}>
    <CardTransitionSettings api={api} action={statusAction}/>
    <View testID="card-detail-frame" style={styles.frame} onLayout={(event) => {
      const next = event.nativeEvent.layout.width;
      setFrameWidth((current) => current === next ? current : next);
    }}>
      <View testID="card-detail-header" style={styles.header}>
        <View style={styles.headerRow}>
          <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round} accessibilityLabel="뒤로" onPress={onClose}>
            <Ionicons testID="card-detail-back-icon" name="chevron-back" size={t.foundation.typography.body.fontSize} color={t.colors.textPrimary} />
          </GlassButton>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="상태 변경" disabled={locked || !api || !card}
            onPress={() => setStatusMenuOpen(true)} frameStyle={styles.titleHitFrame} surfaceStyle={styles.titleHitSurface}>
            <Text testID="card-detail-title" style={styles.heading} numberOfLines={3}>
              {card ? <><CardStatusChip card={card} detail />{' '}{card.title}</> : '카드'}
            </Text>
          </CompactTouchTarget>
          {card ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round}
            variant={allConfirmed ? 'primary' : 'secondary'} accessibilityLabel={actionLabel}
            disabled={locked || !api || startPhase === 'pending'} surfaceTestID="card-detail-complete-visual"
            onPress={() => { void status(startPhase || startable ? 'running' : 'done'); }}>
            <Ionicons name="checkmark" size={t.iconSize.standard} color={allConfirmed ? t.colors.accentText : t.colors.textSecondary} />
          </GlassButton> : null}
        </View>
        {card ? <View style={styles.headerRow}>
          <View style={styles.chips}>
          {!card.assigneeSessionId?<>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="폴더 변경" disabled={locked || !api} onPress={()=>setAssignmentOpen(true)} surfaceStyle={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{useSessionStore.getState().catalog.folders.find(f=>f.id===card.folderId)?.name??card.folderId}</Text></CompactTouchTarget>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="담당 변경" disabled={locked || !api} onPress={() => setAssignmentOpen(true)} surfaceStyle={styles.chip}>{avatar.uri ? <Image source={{ uri: avatar.uri, ...(jwt && avatar.uri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }} style={styles.chipAvatar} /> : <Text style={styles.chipText}>{avatar.fallbackChar}</Text>}
            <Text style={styles.chipText} numberOfLines={1}>{card.assigneeKind === 'human' ? card.assigneeUserId : resolveSessionAgentLabel(identity)}</Text></CompactTouchTarget>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="노드 변경" disabled={locked || !api} onPress={() => setAssignmentOpen(true)} surfaceStyle={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{nodeId ?? '노드 미지정'}</Text></CompactTouchTarget>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="모델 변경" disabled={locked || !api} onPress={() => setAssignmentOpen(true)} surfaceStyle={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{assigned?.modelPreset ?? card.modelPreset ?? '기본 모델'}</Text></CompactTouchTarget>
          </>:null}
          </View>
        </View> : null}
        {statusAction.execution && statusAction.execution.phase !== 'pending' ? <Text style={styles.error}>{statusAction.execution.message}</Text> : null}
      </View>
      {card?.now ? <View style={styles.nowWrap}>
        <CardNowPanel now={card.now} history={detail?.nowHistory ?? []} allConfirmed={allConfirmed}
          surfaceRole={inline ? 'glassCard' : 'panel'} completeDisabled={locked || !api || startPhase === 'pending'}
          onComplete={() => { void status('done'); }} />
      </View> : null}
      <View style={styles.tabsWrap}>
        <SettingsSegmentedControl<CardDetailTab> id="card-detail" variant="detail" value={tab} options={tabOptions} onChange={setTab} />
      </View>
      <View style={styles.bodyFrame}>
        {detail && tab === 'sessions' ? <View testID="card-sessions" style={{ flex: 1, marginBottom: dockBottom }}>
          <FolderSessionHistory api={api} small virtualized sessionIds={sessionIds} sessionSummaries={sessionSummaries} onOpenSession={openSession}
            contentContainerStyle={[styles.content, { paddingBottom: dockHeight + t.uiSpacing.xxl }]} />
        </View> : <ScrollView testID="card-detail-scroll" ref={scroll} style={{ marginBottom: dockBottom }}
          contentContainerStyle={[styles.content, { paddingBottom: dockHeight + t.uiSpacing.xxl }]}
          keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
          onContentSizeChange={() => {
            if (tab === 'comments' && timelineStamp && scrollStamp.current !== timelineStamp) {
              scrollStamp.current = timelineStamp;
              scroll.current?.scrollToEnd({ animated: false });
            }
          }}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {!detail ? <ActivityIndicator color={t.colors.accent} /> : null}
          {detail && tab === 'items' ? <CardCheckItems key={cardId} items={cardItems}
            pendingConfirmations={itemActions.pendingConfirmations} onConfirm={itemActions.confirm}
            initiallyConfirmedIds={currentVisit?.initiallyConfirmedIds ?? []}
            newlyConfirmedIds={currentVisit?.newlyConfirmedIds ?? []}
            onRecentConfirmation={setRecentConfirmation}
            onSetTarget={setItemTarget} paneWidth={frameWidth} /> : null}
          {detail && tab === 'comments' ? <CardTimeline detail={detail} onChooseAnswer={chooseAnswer} /> : null}
          {detail && tab === 'notes' ? <CardNotes brief={detail.card.brief} notes={detail.notes ?? []} sessions={detail.sessions} assigneeSessionId={detail.card.assigneeSessionId} /> : null}
          {detail && tab === 'items' && cardItems.length === 0 ? <Text style={styles.empty}>확인 항목이 없습니다.</Text> : null}
        </ScrollView>}
        <View testID="card-detail-dock" style={[styles.dock, { bottom: dockBottom }]} onLayout={(event) => {
          const next = event.nativeEvent.layout.height;
          setDockHeight((current) => current === next ? current : next);
        }}>
          {sendNotice ? <CompactTouchTarget testID="card-comment-send-notice" surfaceTestID="card-comment-send-notice-surface"
            accessibilityRole="button" accessibilityLabel="커멘트에서 보기" frameStyle={styles.sendNotice}
            surfaceStyle={[styles.sendNoticeSurface, { backgroundColor: t.colors.warningBg, borderColor: t.colors.warning }]}
            onPress={() => setTab('comments')}>
            <Text style={styles.sendNoticeText}>보냈습니다.</Text>
            <Text style={styles.link}>커멘트에서 보기</Text>
          </CompactTouchTarget> : null}
          <CardCommentComposer key={cardId} ref={composer} api={api} cardId={cardId} sessionId={card?.assigneeSessionId} nodeId={nodeId}
            question={question} cardLoaded={!!card} locked={locked} sending={comments.pending || pending} onBusyChange={setComposerBusy}
            sendComment={comments.send} runMutation={run} embedded targetItem={selectedItem}
            onReleaseTarget={() => setTargetChoice(null)} onTargetSent={() => setTargetChoice(null)}
            onSent={() => {
              if (tab === 'comments') {
                requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
              } else {
                setUnreadChoice({ cardId, value: true });
                setNoticeChoice({ cardId, value: true });
              }
            }} />
        </View>
      </View>
    </View>
    {assignmentOpen && card && !card.assigneeSessionId ? <CardAssignmentSheet api={api} mode="edit" value={{ folderId: card.folderId, nodeId: card.nodeId,
      agentId: card.assigneeAgentId, modelPreset: card.modelPreset }} onClose={() => setAssignmentOpen(false)} onSave={async (next) => {
        if (!api) return;
        const serialized=JSON.stringify(next);
        if(!assignmentAttempt.current||assignmentAttempt.current.value!==serialized)assignmentAttempt.current={key:cardOperationId(),value:serialized};
        const ok=await run(()=>api.saveCardExecutionSettings(card.id,next,card.version,assignmentAttempt.current!.key));
        if(!ok)throw new Error('실행 설정을 저장하지 못했습니다.');
      }} /> : null}
  </AppKeyboardAvoidingView>
    {statusMenuOpen && card ? <CardStatusMenu api={api} card={card} onClose={() => setStatusMenuOpen(false)} /> : null}
  </>;
}

function CardReadSummary({ card, items, error, assigneeLabel, hasAssignee, human, avatar, onOpenCard }: {
  card: CardDto | undefined;
  items: CardCheckItem[];
  error: string | null;
  assigneeLabel: string | null;
  hasAssignee: boolean;
  human: boolean | undefined;
  avatar: ReturnType<typeof resolveSessionCardAvatar>;
  onOpenCard(): void;
}) {
  const t = useTokens();
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const profile = useMemo(() => decodeAuthJwt(jwt), [jwt]);
  if (!card) return <View testID={error ? 'card-read-summary-error-state' : 'card-read-summary-loading-state'}
    style={{ flexGrow: 1, flexShrink: 1, minHeight: t.foundation.minHeight.row,
    padding: t.foundation.pageInset, justifyContent: error ? 'flex-start' : 'center', alignItems: error ? 'stretch' : 'center' }}>
    {error ? <Text testID="card-read-summary-error" style={{ ...t.foundation.typography.body, color: t.colors.errorText }}>{error}</Text>
      : <ActivityIndicator color={t.colors.accent} />}
  </View>;

  const assigneeUri = human ? profile?.picture : avatar.uri;
  const assigneeFallback = human ? assigneeLabel?.[0] ?? '사' : avatar.fallbackChar;
  const results = items.filter((item) => item.display !== 'dropped' && !!item.result?.trim());
  const hasRequest = !!card.request.trim() || (card.attachments?.length ?? 0) > 0;
  const hasProgress = !!card.now?.text.trim() || results.length > 0;
  const spacing = t.uiSpacing;

  return <View testID="card-read-summary" style={{ flex: 1, minHeight: 0 }}>
    <ScrollView testID="card-read-summary-scroll" style={{ flex: 1, minHeight: 0 }} showsVerticalScrollIndicator={false}
      contentContainerStyle={{ padding: t.foundation.pageInset, gap: spacing.xl, flexGrow: 1 }}>
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0, gap: spacing.sm }}>
          <CardStatusChip card={card} board detail />
          {card.number == null ? null : <Text testID="card-read-summary-number" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }} numberOfLines={1}>#{card.number}</Text>}
        </View>
        <Text testID="card-read-summary-title" numberOfLines={2} ellipsizeMode="tail"
          style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary }}>
          {card.title}
        </Text>
      </View>
      {hasAssignee ? <View testID="card-read-summary-assignee" style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {assigneeUri
          ? <Image testID="card-read-summary-avatar" source={{ uri: assigneeUri,
            ...(jwt && assigneeUri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }}
            style={{ width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round, flexShrink: 0 }} />
          : <View testID="card-read-summary-avatar" style={{ width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round,
            flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.persistentSession.line, backgroundColor: t.persistentSession.panel }}>
            <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{assigneeFallback}</Text>
          </View>}
        {assigneeLabel ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, flexShrink: 1 }} numberOfLines={1}>{assigneeLabel}</Text> : null}
      </View> : null}
      {hasRequest ? <View testID="card-read-summary-request" style={{ gap: spacing.sm }}>
        <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>요청</Text>
        <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm }}>
          <View style={{ width: spacing.xxs, backgroundColor: t.persistentSession.line }} />
          <View style={{ flex: 1, minWidth: 0 }}><CardRequestView request={card.request} attachments={card.attachments}
            bodyStyle={{ ...t.foundation.typography.body, color: t.colors.textSecondary }} numberOfLines={4} /></View>
        </View>
      </View> : null}
      {hasProgress ? <View testID="card-read-summary-progress" style={{ gap: spacing.sm }}>
        <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>경과</Text>
        {card.now?.text.trim() ? <Text testID="card-read-summary-now" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }} selectable>
          {card.now.text}
        </Text> : null}
        {results.map((item) => <View key={item.id} testID={`card-read-summary-result-${item.id}`} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>•</Text>
          <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary, flex: 1, minWidth: 0 }} selectable>{item.result}</Text>
        </View>)}
      </View> : null}
    </ScrollView>
    <View testID="card-read-summary-footer" style={{ paddingHorizontal: t.foundation.pageInset, paddingTop: spacing.sm, paddingBottom: t.foundation.pageInset }}>
      <GlassButton testID="card-read-summary-open" variant="paper" accessibilityLabel="카드 열기" onPress={onOpenCard} style={{ alignSelf: 'stretch' }}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>카드 열기</Text>
      </GlassButton>
    </View>
  </View>;
}
