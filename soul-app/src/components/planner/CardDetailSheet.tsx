import {CardTransitionSettings} from './CardTransitionSettings';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiClient } from '../../api/client';
import type { CardCheckItem, CardStatus } from '../../api/cardTypes';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useCardComments } from '../../hooks/useCardComments';
import { useCardDetail } from '../../hooks/useCardDetail';
import { useCardItems } from '../../hooks/useCardItems';
import { useUIStore } from '../../store/uiStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
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

export function CardDetailContent({ api, cardId, onClose, onOpenSession, inline = false }: {
  api: ApiClient | null; cardId: string; onClose(): void; onOpenSession?(id: string): void; inline?: boolean;
}) {
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
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
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
  const agent = assigned ?? { agentSessionId: card?.id ?? '', agentId: card?.assigneeAgentId, agentPortraitUrl: null };
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
  const sessionIds = [...new Set([...(card?.assigneeSessionId ? [card.assigneeSessionId] : []), ...(detail?.sessions ?? []).map((session) => session.agentSessionId)])];
  const tabOptions = [
    { value: 'items' as const, label: '확인 항목', count: needsReview || undefined },
    { value: 'comments' as const, label: '커멘트', dot: commentUnread },
    { value: 'sessions' as const, label: '세션', count: tabletLandscape ? sessionIds.length : undefined },
    { value: 'notes' as const, label: '노트', count: tabletLandscape ? (detail?.notes?.length ?? 0) : undefined },
  ];
  const selectedItem = targetItem;
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
          surfaceRole={inline ? 'glassCard' : 'panel'} />
      </View> : null}
      <View style={styles.tabsWrap}>
        <SettingsSegmentedControl<CardDetailTab> id="card-detail" variant="detail" value={tab} options={tabOptions} onChange={setTab} />
      </View>
      <View style={styles.bodyFrame}>
        <ScrollView testID="card-detail-scroll" ref={scroll}
          contentContainerStyle={[styles.content, { paddingBottom: dockHeight + dockBottom + t.uiSpacing.xxl }]}
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
          {detail && tab === 'sessions' ? <View testID="card-sessions" style={styles.sessions}>
            <FolderSessionHistory api={api} small sessionIds={sessionsExpanded ? sessionIds : sessionIds.slice(0, 3)} onOpenSession={openSession} />
            {sessionIds.length > 3 ? <CompactTouchTarget accessibilityRole="button" onPress={() => setSessionsExpanded((old) => !old)}>
              <Text style={styles.link}>{sessionsExpanded ? '접기' : `${sessionIds.length - 3}개 더`}</Text>
            </CompactTouchTarget> : null}
          </View> : null}
          {detail && tab === 'notes' ? <CardNotes brief={detail.card.brief} notes={detail.notes ?? []} sessions={detail.sessions} /> : null}
          {detail && tab === 'items' && cardItems.length === 0 ? <Text style={styles.empty}>확인 항목이 없습니다.</Text> : null}
        </ScrollView>
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
