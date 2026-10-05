import {CardTransitionSettings} from './CardTransitionSettings';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardStatus } from '../../api/cardTypes';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useCardComments } from '../../hooks/useCardComments';
import { useCardDetail } from '../../hooks/useCardDetail';
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
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { PlannerMarkdownText } from './PlannerMarkdownText';
import { CardAssignmentSheet } from './CardAssignmentSheet';
import { CardStatusChip } from './CardRow';
import { CardStatusMenu } from './CardStatusMenu';
import { CardTimeline } from './CardTimeline';
import { cardDetailStyles } from './CardDetail.styles';

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

export function CardDetailContent({ api, cardId, onClose, onOpenSession, inline = false, nativeHeader = false }: {
  api: ApiClient | null; cardId: string; onClose(): void; onOpenSession?(id: string): void; inline?: boolean; nativeHeader?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const folderStyles = useMemo(() => makeFolderWorkspaceStyles(t), [t]);
  const { detail, error } = useCardDetail(api, cardId);
  const { run, pending } = useCardActions(api);
  const statusAction = useCardTransition(api, cardId);
  const comments = useCardComments(api, cardId);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const composer = useRef<CardCommentComposerHandle>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const chooseAnswer = React.useCallback((answer: string) => composer.current?.chooseAnswer(answer), []);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const assignmentAttempt=useRef<{key:string;value:string}|null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const card = detail?.card;
  const startable = card?.status === 'todo' || card?.status === 'queued';
  const startPhase = statusAction.execution?.phase;
  const actionLabel = startPhase === 'pending' ? '시작 중…' : startPhase ? (startPhase === 'delayed' ? '다시 확인' : '다시 시도') : startable ? '시작하기' : '완료';
  const timelineStamp = detail ? `${detail.questions.length}:${detail.reports.length}:${detail.comments?.length ?? 0}` : '';
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
  return <><AppKeyboardAvoidingView testID="card-detail-container" behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={folderStyles.container}>
    <CardTransitionSettings api={api} action={statusAction}/>
    <View testID="card-detail-header" style={styles.header}>
      {!nativeHeader && <View style={styles.headerRow}>
        <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round} accessibilityLabel="뒤로" onPress={onClose}><Text style={styles.glyph}>‹</Text></GlassButton>
        <Text style={styles.heading} numberOfLines={1}>{card?.title ?? '카드'}</Text>
        {card ? <CompactTouchTarget accessibilityRole="button" accessibilityLabel="상태 변경" disabled={locked || !api} onPress={() => setStatusMenuOpen(true)}><CardStatusChip card={card} /></CompactTouchTarget> : null}
      </View>}
      {card ? <View style={styles.headerRow}>
        <View style={styles.chips}>
          {nativeHeader ? <CompactTouchTarget accessibilityRole="button" accessibilityLabel="상태 변경" disabled={locked || !api} onPress={() => setStatusMenuOpen(true)}><CardStatusChip card={card} /></CompactTouchTarget> : null}
          {!card.assigneeSessionId?<>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="폴더 변경" disabled={locked || !api} onPress={()=>setAssignmentOpen(true)} surfaceStyle={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{useSessionStore.getState().catalog.folders.find(f=>f.id===card.folderId)?.name??card.folderId}</Text></CompactTouchTarget>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="담당 변경" disabled={locked || !api} onPress={() => setAssignmentOpen(true)} surfaceStyle={styles.chip}>{avatar.uri ? <Image source={{ uri: avatar.uri, ...(jwt && avatar.uri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }} style={styles.chipAvatar} /> : <Text style={styles.chipText}>{avatar.fallbackChar}</Text>}
            <Text style={styles.chipText} numberOfLines={1}>{card.assigneeKind === 'human' ? card.assigneeUserId : resolveSessionAgentLabel(identity)}</Text></CompactTouchTarget>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="노드 변경" disabled={locked || !api} onPress={() => setAssignmentOpen(true)} surfaceStyle={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{nodeId ?? '노드 미지정'}</Text></CompactTouchTarget>
          <CompactTouchTarget accessibilityRole="button" accessibilityLabel="모델 변경" disabled={locked || !api} onPress={() => setAssignmentOpen(true)} surfaceStyle={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{assigned?.modelPreset ?? card.modelPreset ?? '기본 모델'}</Text></CompactTouchTarget>
          </>:null}
        </View>
        <CompactTouchTarget accessibilityRole="button" accessibilityLabel={actionLabel} accessibilityState={{ disabled: locked || !api || startPhase === 'pending' }} disabled={locked || !api || startPhase === 'pending'}
          surfaceStyle={[styles.done, (locked || !api || startPhase === 'pending') && styles.disabled]} onPress={() => { void status(startPhase || startable ? 'running' : 'done'); }}><Text style={styles.doneText}>{actionLabel}</Text></CompactTouchTarget>
      </View> : null}
      {statusAction.execution && statusAction.execution.phase !== 'pending' ? <Text style={styles.error}>{statusAction.execution.message}</Text> : null}
    </View>
    <ScrollView testID="card-detail-scroll" ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => { if (timelineStamp && scrollStamp.current !== timelineStamp) { scrollStamp.current = timelineStamp; scroll.current?.scrollToEnd({ animated: false }); } }}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!detail ? <ActivityIndicator color={t.colors.accent} /> : null}
      {detail ? <View testID="card-sessions" style={styles.sessions}>
        <FolderSessionHistory api={api} small sessionIds={sessionsExpanded ? sessionIds : sessionIds.slice(0, 3)} onOpenSession={openSession} />
        {sessionIds.length > 3 ? <CompactTouchTarget accessibilityRole="button" onPress={() => setSessionsExpanded((old) => !old)}><Text style={styles.link}>{sessionsExpanded ? '접기' : `${sessionIds.length - 3}개 더`}</Text></CompactTouchTarget> : null}
      </View> : null}
      {detail ? <CardTimeline detail={detail} onChooseAnswer={chooseAnswer} /> : null}
      {detail ? <View testID="card-other">
        <PlannerSectionHeader title="그 밖에" expanded={otherExpanded} onToggle={() => setOtherExpanded((old) => !old)} />
        {otherExpanded ? <PlannerMarkdownText markdown={detail.card.brief || '아직 경과가 없습니다.'} variant="card" /> : null}
      </View> : null}
    </ScrollView>
    <CardCommentComposer ref={composer} api={api} cardId={cardId} sessionId={card?.assigneeSessionId} nodeId={nodeId}
      question={question} cardLoaded={!!card} locked={locked} sending={comments.pending || pending} onBusyChange={setComposerBusy}
      sendComment={comments.send} runMutation={run} />
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
