import { useEffect, useRef, type MutableRefObject } from 'react';
import { LayoutAnimation } from 'react-native';
import type { createApiClient } from '../../api/client';
import type { LiveTextSnapshotWire, SessionEvent } from '../../api/types';
import { toSessionEndedReconciliation } from '../../api/mappers';
import {
  useChatStore,
  type StreamingSlotKind,
} from '../../store/chatStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSSEStream, SESSION_EVENT_TYPES } from '../../hooks/useSSEStream';
import {
  createSessionEventFromSse,
  flushQueuedSseEvents,
  handleSessionSseEvent,
  isLiveOnlyPayload,
  isStateOnlySseEventType,
  shouldAcceptSessionSsePayload,
  type SessionSseFramePhase,
} from './sseGate';
import {
  cancelStreamingDeltaBuffer,
  createStreamingDeltaBuffer,
  dispatchStreamingDelta,
  flushStreamingDeltaBuffer,
  streamingDeltaKind,
  streamingSlotTransitionForEvent,
} from './streamingDeltaBuffer';
import {
  isExplicitLiveTextFinal,
  liveTextEventMetadata,
  normalizeLiveTextSnapshot,
  resetRequiredStreamIdentities,
  snapshotStreamIdentities,
  snapshotStreamingEvents,
} from '../../lib/live-text-recovery';

type ApiClient = ReturnType<typeof createApiClient>;
type PendingRawEvent = {
  type: string;
  data: unknown;
  eid: string;
  liveSeq?: number;
};

interface UseChatSseStreamOptions {
  api: ApiClient | null;
  sessionId: string | undefined;
  active: boolean;
  scopeGeneration: string;
  isCatchingUpRef: MutableRefObject<boolean>;
  historyLoadingRef: MutableRefObject<boolean>;
  pendingLiveQueueRef: MutableRefObject<Array<{ event: SessionEvent; eid: string }>>;
  pendingCatchupQueueRef: MutableRefObject<Array<{ event: SessionEvent; eid: string }>>;
  resetToSnapshot: (
    baselineCursor: string | null,
    commitRecovery: () => boolean,
  ) => void;
  mergeEvents: (sessionId: string, events: SessionEvent[]) => void;
  setLastEventId: (sessionId: string, id: string) => void;
  setStreamingEvent: (
    sessionId: string,
    kind: StreamingSlotKind,
    event: SessionEvent,
  ) => void;
  replaceAssistantStreamingEvents: (
    sessionId: string,
    events: readonly SessionEvent[],
    snapshotStreamIdentities?: readonly string[],
  ) => void;
  clearStreamingEvent: (
    sessionId: string,
    kind: StreamingSlotKind,
    streamIdentity?: string,
  ) => void;
  finalizeStreamingEvent: (
    sessionId: string,
    kind: StreamingSlotKind,
    streamIdentity?: string,
  ) => void;
  applyClaudeRuntimeEvent: (
    sessionId: string,
    type: string,
    data: unknown,
  ) => void;
  streamFailureRef: MutableRefObject<(error: unknown) => void>;
}

export function useChatSseStream({
  api,
  sessionId,
  active,
  scopeGeneration,
  isCatchingUpRef,
  historyLoadingRef,
  pendingLiveQueueRef,
  pendingCatchupQueueRef,
  resetToSnapshot,
  mergeEvents,
  setLastEventId,
  setStreamingEvent,
  replaceAssistantStreamingEvents,
  clearStreamingEvent,
  finalizeStreamingEvent,
  applyClaudeRuntimeEvent,
  streamFailureRef,
}: UseChatSseStreamOptions): void {
  const generationRef = useRef(0);
  const framePhaseRef = useRef<SessionSseFramePhase>('replay');
  const streamingDeltaBufferRef = useRef(createStreamingDeltaBuffer());
  const textSnapshotRef = useRef<LiveTextSnapshotWire | null>(null);
  const historySyncSeenRef = useRef(false);
  const pendingPostSyncQueueRef = useRef<PendingRawEvent[]>([]);
  const pendingPreSnapshotLiveQueueRef = useRef<PendingRawEvent[]>([]);
  const liveTextThroughSeqRef = useRef(0);
  const resetRequiredStreamsRef = useRef<Set<string>>(new Set());
  const pendingResetRecoveryRef = useRef<{
    generation: number;
    snapshot: LiveTextSnapshotWire | null;
    queued: PendingRawEvent[];
    committing: boolean;
  } | null>(null);

  const resetRecoveryRefs = () => {
    framePhaseRef.current = 'replay';
    textSnapshotRef.current = null;
    historySyncSeenRef.current = false;
    pendingPostSyncQueueRef.current = [];
    pendingPreSnapshotLiveQueueRef.current = [];
    liveTextThroughSeqRef.current = 0;
    resetRequiredStreamsRef.current = new Set();
    pendingResetRecoveryRef.current = null;
  };

  const takeReplayEventsAfterSnapshot = (
    snapshot: LiveTextSnapshotWire | null,
  ): PendingRawEvent[] => {
    const queued = pendingPreSnapshotLiveQueueRef.current;
    pendingPreSnapshotLiveQueueRef.current = [];
    const throughLiveSeq = snapshot?.throughLiveSeq ?? 0;
    return queued.filter((event) => (event.liveSeq ?? 0) > throughLiveSeq);
  };

  const reconnectAfterAsyncCommitError = (error: unknown) => {
    streamFailureRef.current(error);
  };

  const suspendStreamState = () => {
    generationRef.current += 1;
    cancelStreamingDeltaBuffer(streamingDeltaBufferRef.current);
    pendingLiveQueueRef.current = [];
    pendingCatchupQueueRef.current = [];
    isCatchingUpRef.current = true;
    resetRecoveryRefs();
    if (sessionId) {
      clearStreamingEvent(sessionId, 'assistant');
      clearStreamingEvent(sessionId, 'thinking');
    }
  };

  useEffect(() => {
    generationRef.current += 1;
    cancelStreamingDeltaBuffer(streamingDeltaBufferRef.current);
    pendingLiveQueueRef.current = [];
    pendingCatchupQueueRef.current = [];
    isCatchingUpRef.current = true;
    resetRecoveryRefs();
    return () => {
      suspendStreamState();
    };
    // refs와 store actions는 안정 reference. active/session/scope만 connection owner다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, scopeGeneration]);

  const processAcceptedEvent = (
    acceptedType: string,
    acceptedData: unknown,
    acceptedEid: string,
  ): void => {
    if (!sessionId) return;
    if (!shouldAcceptSessionSsePayload(sessionId, acceptedData)) return;

    const pendingResetRecovery = pendingResetRecoveryRef.current;
    if (
      pendingResetRecovery
      && !pendingResetRecovery.committing
      && acceptedType !== 'text_snapshot'
      && acceptedType !== 'history_sync'
    ) {
      pendingResetRecovery.queued.push({
        type: acceptedType,
        data: acceptedData,
        eid: acceptedEid,
      });
      return;
    }

    const liveTextMetadata = isLiveTextEventType(acceptedType, acceptedData)
      ? liveTextEventMetadata(acceptedData)
      : null;
    // Snapshot 캡처 뒤 더 새 durable replay는 snapshot 설치 후 의미 적용한다.
    if (
      liveTextMetadata
      && acceptedEid.length > 0
      && isCatchingUpRef.current
      && !historySyncSeenRef.current
    ) {
      pendingPreSnapshotLiveQueueRef.current.push({
        type: acceptedType,
        data: acceptedData,
        eid: acceptedEid,
        liveSeq: liveTextMetadata.liveSeq,
      });
    }

    if (acceptedType === 'text_snapshot') {
      if (!isCatchingUpRef.current || historySyncSeenRef.current) return;
      textSnapshotRef.current = normalizeLiveTextSnapshot(acceptedData);
      return;
    }
    if (
      historySyncSeenRef.current
      && isCatchingUpRef.current
      && acceptedType !== 'history_sync'
    ) {
      pendingPostSyncQueueRef.current.push({
        type: acceptedType,
        data: acceptedData,
        eid: acceptedEid,
      });
      return;
    }
    if (
      !isCatchingUpRef.current
      && !historyLoadingRef.current
      && pendingLiveQueueRef.current.length > 0
    ) {
      flushQueuedSseEvents(
        { pendingLiveQueueRef, isCatchingUpRef },
        {
          triggerAnimation: () => undefined,
          ingestEventsBatch: (events) => mergeEvents(sessionId, events),
          setLastEventId: (id) => setLastEventId(sessionId, id),
        },
      );
    }

    if (liveTextMetadata) {
      if (liveTextMetadata.liveSeq <= liveTextThroughSeqRef.current) return;
      const blocked = resetRequiredStreamsRef.current.has(
        liveTextMetadata.streamIdentity,
      );
      if (blocked && !isExplicitLiveTextFinal(acceptedType, acceptedData)) {
        liveTextThroughSeqRef.current = liveTextMetadata.liveSeq;
        return;
      }
      if (blocked) {
        resetRequiredStreamsRef.current.delete(liveTextMetadata.streamIdentity);
      }
    }

    const flushStreamingDeltas = () =>
      flushStreamingDeltaBuffer(streamingDeltaBufferRef.current, {
        commitStreamingEvent: (kind, event) =>
          setStreamingEvent(sessionId, kind, event),
        setLastEventId: (id) => setLastEventId(sessionId, id),
        onAsyncCommitError: reconnectAfterAsyncCommitError,
      });

    if (acceptedType === 'session_ended') {
      const ended = toSessionEndedReconciliation(acceptedData);
      if (ended) {
        useSessionStore.getState().reconcileSessionEnded(sessionId, ended);
      }
    }
    applyClaudeRuntimeEvent(sessionId, acceptedType, acceptedData);
    if (isStateOnlySseEventType(acceptedType)) {
      // Buffered thinking을 commit한 뒤에만 새 runtime eid를 cursor로 확정한다.
      flushStreamingDeltas();
      if (
        acceptedEid
        && !isCatchingUpRef.current
        && !historyLoadingRef.current
      ) {
        setLastEventId(sessionId, acceptedEid);
      }
      return;
    }

    const streamingKind = streamingDeltaKind(acceptedType);
    const shouldUseLiveStreamingSlot =
      streamingKind
      && (isLiveOnlyPayload(acceptedData) || liveTextMetadata !== null)
      && !isCatchingUpRef.current
      && (!historyLoadingRef.current || liveTextMetadata !== null);
    if (shouldUseLiveStreamingSlot) {
      const { event, eventId } = createSessionEventFromSse(
        acceptedType,
        acceptedData,
        acceptedEid,
        framePhaseRef.current,
      );
      dispatchStreamingDelta(
        streamingDeltaBufferRef.current,
        {
          kind: streamingKind,
          event,
          eid: historyLoadingRef.current ? '' : eventId,
        },
        {
          commitStreamingEvent: (kind, nextEvent) =>
            setStreamingEvent(sessionId, kind, nextEvent),
          setLastEventId: (id) => setLastEventId(sessionId, id),
          onAsyncCommitError: reconnectAfterAsyncCommitError,
        },
      );
      if (liveTextMetadata) {
        liveTextThroughSeqRef.current = liveTextMetadata.liveSeq;
      }
      return;
    }

    flushStreamingDeltas();
    const transition = streamingSlotTransitionForEvent(
      acceptedType,
      acceptedData,
    );
    for (const kind of transition.clear) {
      clearStreamingEvent(
        sessionId,
        kind,
        kind === 'assistant' ? liveTextMetadata?.streamIdentity : undefined,
      );
    }
    for (const kind of transition.finalize) {
      finalizeStreamingEvent(
        sessionId,
        kind,
        kind === 'assistant' ? liveTextMetadata?.streamIdentity : undefined,
      );
    }
    if (acceptedType === 'history_sync') {
      historySyncSeenRef.current = true;
      if (isHistorySyncReset(acceptedData)) {
        const receivedSnapshot = textSnapshotRef.current;
        const syncLastEventId = historySyncLastEventId(acceptedData);
        const matchingSnapshot = receivedSnapshot?.basedOnEventId === syncLastEventId
          ? receivedSnapshot
          : null;
        // v2 producer는 한 history.lastStoredId를 snapshot/marker 양쪽에 넣고,
        // snapshot 뒤 수신분은 marker 다음에 liveSeq 순서로 보낸다.
        pendingResetRecoveryRef.current = {
          generation: generationRef.current,
          snapshot: matchingSnapshot,
          queued: takeReplayEventsAfterSnapshot(matchingSnapshot),
          committing: false,
        };
        textSnapshotRef.current = null;
      }
    }
    handleSessionSseEvent(
      acceptedType,
      acceptedData,
      acceptedEid,
      {
        framePhaseRef,
        isCatchingUpRef,
        historyLoadingRef,
        pendingLiveQueueRef,
        pendingCatchupQueueRef,
        generationRef,
      },
      {
        triggerAnimation: () =>
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut),
        ingestEvent: (event) => mergeEvents(sessionId, [event]),
        ingestEventsBatch: (events) => mergeEvents(sessionId, events),
        setLastEventId: (id) => setLastEventId(sessionId, id),
        resetToSnapshot: (baselineCursor) => {
          cancelStreamingDeltaBuffer(streamingDeltaBufferRef.current);
          const recovery = pendingResetRecoveryRef.current;
          resetToSnapshot(baselineCursor, () => {
            if (
              !recovery
              || pendingResetRecoveryRef.current !== recovery
              || recovery.generation !== generationRef.current
            ) {
              return false;
            }
            recovery.committing = true;
            try {
              liveTextThroughSeqRef.current =
                recovery.snapshot?.throughLiveSeq ?? 0;
              resetRequiredStreamsRef.current =
                resetRequiredStreamIdentities(recovery.snapshot);
              replaceAssistantStreamingEvents(
                sessionId,
                snapshotStreamingEvents(recovery.snapshot),
                snapshotStreamIdentities(recovery.snapshot),
              );
              for (const pending of recovery.queued) {
                processAcceptedEvent(pending.type, pending.data, pending.eid);
              }
              pendingResetRecoveryRef.current = null;
              return true;
            } catch (error) {
              recovery.committing = false;
              throw error;
            }
          });
        },
        onCatchupCommitted: () => {
          const receivedSnapshot = textSnapshotRef.current;
          const syncLastEventId = historySyncLastEventId(acceptedData);
          const snapshot = receivedSnapshot?.basedOnEventId === syncLastEventId
            ? receivedSnapshot
            : null;
          const replayedAfterSnapshot = takeReplayEventsAfterSnapshot(snapshot);
          liveTextThroughSeqRef.current = snapshot?.throughLiveSeq ?? 0;
          resetRequiredStreamsRef.current =
            resetRequiredStreamIdentities(snapshot);
          replaceAssistantStreamingEvents(
            sessionId,
            snapshotStreamingEvents(snapshot),
            snapshotStreamIdentities(snapshot),
          );
          textSnapshotRef.current = null;
          historySyncSeenRef.current = false;
          for (const pending of replayedAfterSnapshot) {
            processAcceptedEvent(pending.type, pending.data, pending.eid);
          }
          const queued = pendingPostSyncQueueRef.current;
          pendingPostSyncQueueRef.current = [];
          for (const pending of queued) {
            processAcceptedEvent(pending.type, pending.data, pending.eid);
          }
        },
        onAsyncCommitError: reconnectAfterAsyncCommitError,
      },
    );
    if (acceptedType === 'history_sync' && isHistorySyncReset(acceptedData)) {
      historySyncSeenRef.current = false;
      pendingPostSyncQueueRef.current = [];
      liveTextThroughSeqRef.current = 0;
      resetRequiredStreamsRef.current = new Set();
    } else if (liveTextMetadata && !historyLoadingRef.current) {
      liveTextThroughSeqRef.current = liveTextMetadata.liveSeq;
    }
  };

  useSSEStream({
    diagnosticsSource: 'chat_stream',
    urlBuilder: () => {
      if (!api || !sessionId) return '';
      const lastId = useChatStore.getState().lastEventIdBySession[sessionId];
      return api.sessionEventsUrl(sessionId, lastId);
    },
    connectionKey: sessionId,
    scopeGeneration,
    eventTypes: [...SESSION_EVENT_TYPES],
    enabled: active && !!api && !!sessionId,
    consumerFailureRef: streamFailureRef,
    onSuspending: suspendStreamState,
    onOpen: () => {
      generationRef.current += 1;
      cancelStreamingDeltaBuffer(streamingDeltaBufferRef.current);
      pendingLiveQueueRef.current = [];
      pendingCatchupQueueRef.current = [];
      isCatchingUpRef.current = true;
      resetRecoveryRefs();
    },
    onEvent: processAcceptedEvent,
    onError: (err) => {
      if (sessionId) {
        flushStreamingDeltaBuffer(streamingDeltaBufferRef.current, {
          commitStreamingEvent: (kind, event) =>
            setStreamingEvent(sessionId, kind, event),
          setLastEventId: (id) => setLastEventId(sessionId, id),
          onAsyncCommitError: reconnectAfterAsyncCommitError,
        });
      }
      console.warn('[ChatBody] SSE error:', err);
    },
  });
}

function isLiveTextEventType(type: string, data: unknown): boolean {
  return type === 'text_start'
    || type === 'text_delta'
    || type === 'text_end'
    || isExplicitLiveTextFinal(type, data);
}

function isHistorySyncReset(data: unknown): boolean {
  return typeof data === 'object' && data !== null
    && (data as Record<string, unknown>).reset_required === true;
}

function historySyncLastEventId(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = (data as Record<string, unknown>).last_event_id;
  const parsed = typeof raw === 'number' || typeof raw === 'string'
    ? Number(raw)
    : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
