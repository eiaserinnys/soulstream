import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Alert, Text, View, type LayoutChangeEvent, type LayoutRectangle } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { Session, SessionEvent } from '../../api/types';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { useNodeConnectivityStore } from '../../store/nodeConnectivityStore';
import { useChatStore } from '../../store/chatStore';
import { isSessionOnDisconnectedNode } from '../../lib/session-node-projection';
import { createUiUsageFlowId, recordUiUsageEvent } from '../../lib/ui-usage-events';
import { useTokens } from '../../theme';
import { makeStyles } from './ChatBody.styles';
import { CHAT_SEND_ERROR_MESSAGES, useChatSendFlow, type ChatSendUsageEvent } from './useChatSendFlow';
import { ChatComposer } from './ChatComposer';
import { AttachmentChips } from './AttachmentChips';
import { ChatInterruptButton } from './ChatInterruptButton';
import { RealtimeVoiceControls } from './RealtimeVoiceControls';

export interface ChatInputComposerHandle {
  retryPending(eventId: string): void;
  restorePending(eventId: string): void;
}
interface Props {
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
  onComposerLayout?: (event: LayoutChangeEvent, composerBox: LayoutRectangle) => void;
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
  presentation = 'default', onComposerLayout,
}, ref) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const composerAnchorLayout = useRef<LayoutChangeEvent | null>(null);
  const composerBoxLayout = useRef<LayoutRectangle | null>(null);
  const composerRowLayout = useRef<LayoutRectangle | null>(null);
  const reportComposerLayout = useCallback(() => {
    const anchor = composerAnchorLayout.current;
    const row = composerRowLayout.current;
    const box = composerBoxLayout.current;
    if (anchor && row && box) {
      onComposerLayout?.(anchor, { ...box, y: anchor.nativeEvent.layout.height - row.height + box.y });
    }
  }, [onComposerLayout]);
  const handleComposerAnchorLayout = useCallback((event: LayoutChangeEvent) => {
    composerAnchorLayout.current = event;
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
    inputRef.current = '';
    composeFlowRef.current = null;
    inputDraft.clear();
  }, [inputDraft.clear]);

  const handleInputChange = useCallback((value: string) => {
    const previous = inputRef.current;
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
  });

  const handleRestorePending = useCallback((eventId: string) => {
    const restored = restorePendingOptimistic(eventId, inputRef.current);
    if (!restored) return;
    inputRef.current = restored.inputText;
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
  }), [retryPendingOptimistic, handleRestorePending]);
  useEffect(() => {
    composeFlowRef.current = null;
    clearAttachments();
  }, [sessionId, api, clearAttachments]);
  const attachmentsAndComposer = <>
    <AttachmentChips
      attachments={attachments}
      styles={styles}
      textSecondaryColor={t.colors.textSecondary}
      textMutedColor={t.colors.textMuted}
      onRemove={removeAttachment}
      disabled={inputDisabled}
      {...(presentation === 'manuscript' ? { presentation } : {})}
    />

    <ChatComposer
      input={input}
      onChangeInput={handleInputChange}
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
