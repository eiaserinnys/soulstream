import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Alert, Text } from 'react-native';
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
  session: Session | undefined;
  api: ApiClient | null;
  detailedNetworkActive: boolean;
  appForeground: boolean;
  minimumBottomPadding: number;
  requestBottomFollow(): void;
}

const EMPTY_EVENTS: SessionEvent[] = [];
// Voice approval follows history independently; incoming rows do not render the text input.
const ChatVoiceControls = memo(function ChatVoiceControls(props: Omit<React.ComponentProps<typeof RealtimeVoiceControls>, 'events'>) {
  const events = useChatStore(state => props.sessionId
    ? state.eventsBySession[props.sessionId] ?? EMPTY_EVENTS : EMPTY_EVENTS);
  return <RealtimeVoiceControls {...props} events={events} />;
});

export const ChatInputComposer = memo(forwardRef<ChatInputComposerHandle, Props>(function ChatInputComposer({
  sessionId, session, api, detailedNetworkActive, appForeground, minimumBottomPadding, requestBottomFollow,
}, ref) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const nodesReady = useNodeConnectivityStore(state => state.ready);
  const connectedNodeIds = useNodeConnectivityStore(state => state.connectedNodeIds);
  const inputDraft = usePersistentDraft('chat', [session?.nodeId, sessionId], '');
  const inputDisabled = !inputDraft.ready || (session ? isSessionOnDisconnectedNode(session, {
    ready: nodesReady, connectedNodeIds,
  }) : false);
  const input = inputDraft.value;
  const [interrupting, setInterrupting] = useState(false);
  const inputRef = useRef(input);
  const composeFlowRef = useRef<{
    flowId: string;
    sessionId: string;
    abandoned: boolean;
  } | null>(null);
  const wasComposerVisibleRef = useRef(detailedNetworkActive);

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
    nodeId: session?.nodeId,
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
    session,
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
    setInterrupting(true);
    try {
      await api.interruptSession(sessionId);
    } catch (e: any) {
      Alert.alert('중단 실패', e?.message ?? '알 수 없는 오류');
    } finally {
      setInterrupting(false);
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
  return <>
      {sendError && sendError !== CHAT_SEND_ERROR_MESSAGES.disabled ? (
        <Text style={styles.errorText}>{sendError}</Text>
      ) : null}

      {inputDisabled ? (
        <Text testID="chat-offline-input-notice" style={styles.offlineNotice}>
          노드 연결을 기다리는 동안 메시지와 첨부를 보낼 수 없습니다.
        </Text>
      ) : null}

      <AttachmentChips
        attachments={attachments}
        styles={styles}
        textSecondaryColor={t.colors.textSecondary}
        textMutedColor={t.colors.textMuted}
        onRemove={removeAttachment}
        disabled={inputDisabled}
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
        interruptControls={
          session?.status === 'running' ? (
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
            backend={session?.backend}
            disabled={sending || inputDisabled}
            compact
          />
        }
      />
  </>;
}));
