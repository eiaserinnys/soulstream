import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, Platform, Text, View, type LayoutChangeEvent, type LayoutRectangle, type TextInput } from 'react-native';
import type { ReportReplyDraft, ReportSendContext } from '../../lib/persistent-report';
import type { ApiClient } from '../../api/client';
import type { Session, SessionEvent } from '../../api/types';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { useNodeConnectivityStore } from '../../store/nodeConnectivityStore';
import { useChatStore } from '../../store/chatStore';
import { isSessionOnDisconnectedNode } from '../../lib/session-node-projection';
import { createUiUsageFlowId, recordUiUsageEvent } from '../../lib/ui-usage-events';
import { useTokens } from '../../theme';
import { getChatRowHorizontalInset, makeStyles } from './ChatBody.styles';
import { CHAT_SEND_ERROR_MESSAGES, useChatSendFlow, type ChatSendUsageEvent } from './useChatSendFlow';
import { CHAT_COMPOSER_MAX_LENGTH, ChatComposer } from './ChatComposer';
import { AttachmentChips } from './AttachmentChips';
import { ChatInterruptButton } from './ChatInterruptButton';
import { RealtimeVoiceControls } from './RealtimeVoiceControls';
import { GlassButton } from '../GlassSurface';

export type AppendGeneratedTextResult =
  | { ok: true }
  | { ok: false; reason: 'wrong_session' | 'not_ready' | 'sending' | 'disabled' | 'too_long' };

export interface ChatInputComposerHandle {
  retryPending(eventId: string): void;
  restorePending(eventId: string): void;
  appendGeneratedText(sessionId: string, text: string, reportReply?: ReportReplyDraft): AppendGeneratedTextResult;
  focusAccessibility(): void;
}
interface Props {
  getReportSendContext?: (text: string, reply: ReportReplyDraft | null) => ReportSendContext;
  sessionId: string;
  sessionStatus: Session['status'] | undefined;
  nodeId: Session['nodeId'];
  backend: Session['backend'];
  api: ApiClient | null;
  detailedNetworkActive: boolean;
  appForeground: boolean;
  minimumBottomPadding: number;
  requestBottomFollow(): void;
  presentation?: 'default' | 'manuscript';
  generatedNotice?: React.ReactNode;
  /** Runs when submitting clears the composer, before the API result. */
  onComposerClearedForSend?: () => void;
  onComposerLayout?: (anchorLayout: LayoutRectangle, composerBox: LayoutRectangle) => void;
}

const EMPTY_EVENTS: SessionEvent[] = [];
const INTERRUPT_PENDING_RELEASE_MS = 10_000;
// Voice approval follows history independently; incoming rows do not render the text input.
const ChatVoiceControls = memo(function ChatVoiceControls(props: Omit<React.ComponentProps<typeof RealtimeVoiceControls>, 'events'>) {
  const events = useChatStore(state => props.sessionId
    ? state.eventsBySession[props.sessionId] ?? EMPTY_EVENTS : EMPTY_EVENTS);
  return <RealtimeVoiceControls {...props} events={events} />;
});

export const ChatInputComposer = memo(forwardRef<ChatInputComposerHandle, Props>(function ChatInputComposer({
  sessionId, sessionStatus, nodeId, backend, api, detailedNetworkActive, appForeground, minimumBottomPadding, requestBottomFollow,
  presentation = 'default', generatedNotice, onComposerClearedForSend, onComposerLayout, getReportSendContext,
}, ref) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const composerAnchorLayout = useRef<LayoutRectangle | null>(null);
  const composerBoxLayout = useRef<LayoutRectangle | null>(null);
  const composerRowLayout = useRef<LayoutRectangle | null>(null);
  const reportComposerLayout = useCallback(() => {
    const anchor = composerAnchorLayout.current;
    const row = composerRowLayout.current;
    const box = composerBoxLayout.current;
    if (anchor && row && box) {
      onComposerLayout?.(anchor, { ...box, y: anchor.height - row.height + box.y });
    }
  }, [onComposerLayout]);
  const handleComposerAnchorLayout = useCallback((event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    composerAnchorLayout.current = { x, y, width, height };
    reportComposerLayout();
  }, [reportComposerLayout]);
  const handleComposerBoxLayout = useCallback((box: LayoutRectangle, row: LayoutRectangle) => {
    composerBoxLayout.current = box;
    composerRowLayout.current = row;
    reportComposerLayout();
  }, [reportComposerLayout]);
  const nodesReady = useNodeConnectivityStore(state => state.ready);
  const connectedNodeIds = useNodeConnectivityStore(state => state.connectedNodeIds);
  const inputDraft = usePersistentDraft('chat', [nodeId, sessionId], '');
  const sendSession = useMemo(() => sessionStatus === undefined ? undefined : { status: sessionStatus }, [sessionStatus]);
  const inputDisabled = !inputDraft.ready || (sendSession ? isSessionOnDisconnectedNode({ ...sendSession, nodeId }, {
    ready: nodesReady, connectedNodeIds,
  }) : false);
  const input = inputDraft.value;
  const textInputRef = useRef<TextInput | null>(null);
  const reportReplyRef = useRef<ReportReplyDraft | null>(null);
  const [generatedUndo, setGeneratedUndo] = useState<{ before: string; after: string } | null>(null);
  const [generatedSelection, setGeneratedSelection] = useState<{ start: number; end: number } | undefined>();
  const [interrupting, setInterrupting] = useState(false);
  const interruptReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStatusRef = useRef(sessionStatus);
  const mountedRef = useRef(false);
  sessionStatusRef.current = sessionStatus;
  const inputRef = useRef(input);
  const composeFlowRef = useRef<{
    flowId: string;
    sessionId: string;
    abandoned: boolean;
  } | null>(null);
  const wasComposerVisibleRef = useRef(detailedNetworkActive);

  const clearInterruptReleaseTimer = useCallback(() => {
    if (interruptReleaseTimerRef.current === null) return;
    clearTimeout(interruptReleaseTimerRef.current);
    interruptReleaseTimerRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearInterruptReleaseTimer();
    };
  }, [clearInterruptReleaseTimer]);

  useEffect(() => {
    if (sessionStatus === 'running') return;
    clearInterruptReleaseTimer();
    setInterrupting(false);
  }, [clearInterruptReleaseTimer, sessionStatus]);

  const abandonComposer = useCallback((reason: string) => {
    const flow = composeFlowRef.current;
    const draft = inputRef.current;
    if (!flow || flow.abandoned || draft.length === 0) return;
    recordUiUsageEvent({
      type: 'compose_abandon',
      target: { kind: 'session', id: flow.sessionId },
      flowId: flow.flowId,
      attrs: { draftPresent: true, draftLength: draft.length, reason },
    });
    flow.abandoned = true;
  }, []);

  const resumeComposer = useCallback(() => {
    const flow = composeFlowRef.current;
    const draft = inputRef.current;
    if (!flow || !flow.abandoned || draft.length === 0) return;
    recordUiUsageEvent({
      type: 'compose_resume',
      target: { kind: 'session', id: flow.sessionId },
      flowId: flow.flowId,
      attrs: { draftPresent: true, draftLength: draft.length },
    });
    flow.abandoned = false;
  }, []);

  const clearComposerInput = useCallback(() => {
    reportReplyRef.current = null;
    inputRef.current = '';
    composeFlowRef.current = null;
    setGeneratedUndo(null);
    setGeneratedSelection(undefined);
    inputDraft.clear();
    onComposerClearedForSend?.();
  }, [inputDraft.clear, onComposerClearedForSend]);

  const handleInputChange = useCallback((value: string) => {
    if (reportReplyRef.current && !value.includes(reportReplyRef.current.text)) reportReplyRef.current = null;
    const previous = inputRef.current;
    if (previous !== value) {
      setGeneratedUndo(null);
      setGeneratedSelection(undefined);
    }
    if (!previous && value && sessionId) {
      const flowId = createUiUsageFlowId();
      if (flowId) {
        composeFlowRef.current = { flowId, sessionId, abandoned: false };
        recordUiUsageEvent({
          type: 'compose_start',
          target: { kind: 'session', id: sessionId },
          flowId,
          attrs: { mode: 'chat' },
        });
      }
    }
    if (previous && !value) composeFlowRef.current = null;
    inputRef.current = value;
    inputDraft.setValue(value);
  }, [sessionId, inputDraft.setValue]);

  const handleSendUsage = useCallback((event: ChatSendUsageEvent) => {
    const flowId = event.flowId === undefined
      ? composeFlowRef.current?.flowId
      : event.flowId;
    if (!flowId || !sessionId) return;
    if (event.kind === 'submit') {
      recordUiUsageEvent({
        type: 'compose_submit',
        target: { kind: 'session', id: sessionId },
        flowId,
        attrs: { draftLength: event.draftLength, mode: 'chat' },
      });
      return;
    }
    recordUiUsageEvent({
      type: 'compose_result',
      target: { kind: 'session', id: sessionId },
      flowId,
      attrs: {
        status: event.status,
        durationMs: event.durationMs,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.sessionEventId === undefined
          ? {}
          : { sessionEventId: event.sessionEventId }),
      },
    });
  }, [sessionId]);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    const visible = detailedNetworkActive;
    if (wasComposerVisibleRef.current && !visible) {
      abandonComposer(appForeground ? 'view_blur' : 'app_inactive');
    } else if (!wasComposerVisibleRef.current && visible) {
      resumeComposer();
    }
    wasComposerVisibleRef.current = visible;
  }, [abandonComposer, appForeground, detailedNetworkActive, resumeComposer]);

  useEffect(() => () => abandonComposer('component_unmount'), [abandonComposer]);

  const {
    attachments,
    uploading,
    pickAttachment,
    removeAttachment,
    clearAttachments,
    restoreAttachments,
  } = useChatAttachments({
    api,
    sessionId,
    nodeId,
    disabled: inputDisabled,
  });

  const {
    sending,
    hasPendingOptimistic,
    sendError,
    handleSend,
    retryPendingOptimistic,
    restorePendingOptimistic,
  } = useChatSendFlow({
    api,
    sessionId,
    session: sendSession,
    attachments,
    clearAttachments,
    disabled: inputDisabled,
    scrollToBottom: requestBottomFollow,
    onUsageEvent: handleSendUsage,
    getMessageContext: getReportSendContext ? text => getReportSendContext(text, reportReplyRef.current) : undefined,
  });

  const focusInputAtSelection = useCallback((selection: { start: number; end: number }) => {
    setGeneratedSelection(selection);
    requestAnimationFrame(() => {
      const textInput = textInputRef.current;
      textInput?.focus();
      if (Platform.OS === 'web') {
        const webInput = textInput as unknown as { setSelectionRange?: (start: number, end: number) => void } | null;
        webInput?.setSelectionRange?.(selection.start, selection.end);
      }
    });
  }, []);

  const appendGeneratedText = useCallback((targetSessionId: string, text: string, reportReply?: ReportReplyDraft): AppendGeneratedTextResult => {
    if (targetSessionId !== sessionId) return { ok: false, reason: 'wrong_session' };
    if (!inputDraft.ready) return { ok: false, reason: 'not_ready' };
    if (sending) return { ok: false, reason: 'sending' };
    if (inputDisabled) return { ok: false, reason: 'disabled' };
    if (!text) return { ok: true };

    const before = inputRef.current;
    const after = before ? `${before}\n\n${text}` : text;
    if (after.length > CHAT_COMPOSER_MAX_LENGTH) return { ok: false, reason: 'too_long' };

    handleInputChange(after);
    if (reportReply) reportReplyRef.current = reportReply;
    setGeneratedUndo({ before, after });
    focusInputAtSelection({ start: after.length, end: after.length });
    return { ok: true };
  }, [focusInputAtSelection, handleInputChange, inputDisabled, inputDraft.ready, sending, sessionId]);

  const undoGeneratedText = useCallback(() => {
    reportReplyRef.current = null;
    const undo = generatedUndo;
    if (!undo || inputRef.current !== undo.after) return;
    handleInputChange(undo.before);
    setGeneratedUndo(null);
    focusInputAtSelection({ start: undo.before.length, end: undo.before.length });
  }, [focusInputAtSelection, generatedUndo, handleInputChange]);

  const handleGeneratedSelectionChange = useCallback(() => {
    setGeneratedSelection(undefined);
  }, []);

  const handleRestorePending = useCallback((eventId: string) => {
    const restored = restorePendingOptimistic(eventId, inputRef.current);
    if (!restored) return;
    inputRef.current = restored.inputText;
    reportReplyRef.current = restored.reportReply ?? null;
    setGeneratedUndo(null);
    setGeneratedSelection(undefined);
    inputDraft.setValue(restored.inputText);
    if (!composeFlowRef.current && sessionId) {
      const flowId = createUiUsageFlowId();
      if (flowId) {
        composeFlowRef.current = { flowId, sessionId, abandoned: false };
        recordUiUsageEvent({
          type: 'compose_start',
          target: { kind: 'session', id: sessionId },
          flowId,
          attrs: { mode: 'chat' },
        });
      }
    }
    restoreAttachments(restored.attachments.map((attachment) => ({
      path: attachment.path,
      name: attachment.name ?? attachment.path,
    })));
  }, [restoreAttachments, restorePendingOptimistic, sessionId, inputDraft.setValue]);

  const handleInterrupt = async () => {
    if (!api || !sessionId || interrupting) return;
    clearInterruptReleaseTimer();
    setInterrupting(true);
    try {
      await api.interruptSession(sessionId);
      if (!mountedRef.current) return;
      if (sessionStatusRef.current !== 'running') {
        setInterrupting(false);
        return;
      }
      interruptReleaseTimerRef.current = setTimeout(() => {
        interruptReleaseTimerRef.current = null;
        setInterrupting(false);
      }, INTERRUPT_PENDING_RELEASE_MS);
    } catch (e: any) {
      clearInterruptReleaseTimer();
      setInterrupting(false);
      Alert.alert('중단 실패', e?.message ?? '알 수 없는 오류');
    }
  };


  useImperativeHandle(ref, () => ({
    retryPending: eventId => { void retryPendingOptimistic(eventId); },
    restorePending: handleRestorePending,
    appendGeneratedText,
    focusAccessibility: () => {
      if (Platform.OS === 'web') { textInputRef.current?.focus(); return; }
      const handle = findNodeHandle(textInputRef.current);
      if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
    },
  }), [appendGeneratedText, retryPendingOptimistic, handleRestorePending]);
  useEffect(() => {
    composeFlowRef.current = null;
    clearAttachments();
  }, [sessionId, api, clearAttachments]);
  const showGeneratedNotice = generatedNotice !== undefined && generatedNotice !== null;
  const showGeneratedUndo = generatedUndo !== null && input === generatedUndo.after;
  const showComposerAuxiliaryRow = attachments.length > 0 || showGeneratedUndo;
  const generatedUndoButton = showGeneratedUndo ? (
    <GlassButton
      testID="chat-composer-generated-undo-button"
      accessibilityLabel="되돌리기"
      size="compact"
      variant={presentation === 'manuscript' ? 'paper' : 'secondary'}
      style={attachments.length === 0 ? { marginLeft: 'auto', flexShrink: 0 } : undefined}
      onPress={undoGeneratedText}
    >
      <Text style={{ fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio, color: t.colors.textPrimary }}>
        되돌리기
      </Text>
    </GlassButton>
  ) : null;
  const attachmentsAndComposer = <>
    {showComposerAuxiliaryRow ? (
      <View
        testID="chat-composer-generated-row"
        style={[
          styles.generatedTextRow,
          {
            paddingHorizontal: getChatRowHorizontalInset(t, presentation),
            ...(presentation === 'manuscript' ? { paddingBottom: t.spacing.sm } : {}),
          },
        ]}
      >
        {attachments.length > 0 ? (
          <View style={styles.generatedAttachmentSlot}>
            <AttachmentChips
              attachments={attachments}
              styles={styles}
              containerStyle={[styles.attachmentRow, {
                paddingHorizontal: 0,
                paddingTop: 0,
              }]}
              trailingAccessory={generatedUndoButton}
              textSecondaryColor={t.colors.textSecondary}
              textMutedColor={t.colors.textMuted}
              onRemove={removeAttachment}
              disabled={inputDisabled}
              {...(presentation === 'manuscript' ? { presentation } : {})}
            />
          </View>
        ) : null}
        {attachments.length === 0 ? generatedUndoButton : null}
      </View>
    ) : null}
    {showGeneratedNotice ? (
      <View testID="chat-composer-generated-notice-row" style={[
        styles.generatedNoticeRow,
        { paddingHorizontal: getChatRowHorizontalInset(t, presentation),
          ...(presentation === 'manuscript' ? { paddingTop: t.spacing.lg } : {}) },
      ]}>
        <View style={styles.generatedNoticeSlot}>{generatedNotice}</View>
      </View>
    ) : null}

    <ChatComposer
      input={input}
      onChangeInput={handleInputChange}
      onInputRef={(textInput) => { textInputRef.current = textInput; }}
      focusAccent
      selection={generatedSelection}
      onSelectionChange={handleGeneratedSelectionChange}
      onPickAttachment={pickAttachment}
      onSend={() => handleSend(input, clearComposerInput, composeFlowRef.current?.flowId ?? null)}
      uploading={uploading}
      sending={sending}
      hasPendingOptimistic={hasPendingOptimistic}
      disabled={inputDisabled}
      minimumBottomPadding={minimumBottomPadding}
      presentation={presentation}
      interruptControls={
        sessionStatus === 'running' ? (
          <ChatInterruptButton
            interrupting={interrupting}
            disabled={interrupting || !api}
            styles={styles}
            accentTextColor={t.colors.accentText}
            textPrimaryColor={t.colors.textPrimary}
            presentation={presentation}
            onPress={handleInterrupt}
          />
        ) : null
      }
      voiceControls={
        <ChatVoiceControls
          api={api}
          sessionId={sessionId}
          backend={backend}
          disabled={sending || inputDisabled}
          compact
          presentation={presentation}
        />
      }
      {...(onComposerLayout ? { onComposerBoxLayout: handleComposerBoxLayout } : {})}
    />
  </>;
  return <>
      {sendError && sendError !== CHAT_SEND_ERROR_MESSAGES.disabled ? (
        <Text style={styles.errorText}>{sendError}</Text>
      ) : null}

      {inputDisabled ? (
        <Text testID="chat-offline-input-notice" style={styles.offlineNotice}>
          노드 연결을 기다리는 동안 메시지와 첨부를 보낼 수 없습니다.
        </Text>
      ) : null}

      {onComposerLayout ? (
        <View testID="chat-composer-anchor" collapsable={false} onLayout={handleComposerAnchorLayout}>
          {attachmentsAndComposer}
        </View>
      ) : attachmentsAndComposer}
  </>;
}));
