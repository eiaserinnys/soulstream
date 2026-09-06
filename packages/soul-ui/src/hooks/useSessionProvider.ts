/**
 * Provider-backed detail stream controller.
 *
 * Only the currently visible chat owns a detail SSE. Durable cursors advance after
 * synchronous event processing succeeds, and are retained in the provider-owned cache.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import type { SoulSSEEvent } from "../shared/types";
import type { SessionStorageProvider } from "../providers/types";
import type { DetailCursorStore } from "../providers/detail-cursor-store";
import { BATCH_SIZE, BATCH_FLUSH_MS } from "../lib/event-batch";

const PROCESSING_RETRY_BASE_MS = 1_000;
const PROCESSING_RETRY_MAX_MS = 30_000;
const PROCESSING_RECOVERY_STABLE_MS = 30_000;

export interface UseSessionProviderOptions {
  sessionKey: string | null;
  /** Provider/server/user identity. Provider identity itself is isolated by its owned store. */
  cursorScope: string;
  /** Hidden chat surfaces do not fetch or subscribe. */
  active?: boolean;
  getSessionProvider: () => SessionStorageProvider;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface QueuedEvent {
  event: SoulSSEEvent;
  eventId: number;
  generation: number;
}

interface DetailSource {
  sessionKey: string | null;
  cursorScope: string;
  provider: SessionStorageProvider | null;
}

interface ActiveDetailConnection {
  generation: number;
  disconnect: () => void;
}

export function useSessionProvider(options: UseSessionProviderOptions) {
  const {
    sessionKey,
    cursorScope,
    active = true,
    getSessionProvider,
  } = options;

  const processEvents = useDashboardStore((state) => state.processEvents);
  const clearTree = useDashboardStore((state) => state.clearTree);
  const clearTreeRef = useRef(clearTree);
  clearTreeRef.current = clearTree;
  const processEventsRef = useRef(processEvents);
  processEventsRef.current = processEvents;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [synchronizedSessionKey, setSynchronizedSessionKey] = useState<string | null>(null);
  const [reconnectVersion, setReconnectVersion] = useState(0);

  const generationRef = useRef(0);
  const sourceRef = useRef<DetailSource>({
    sessionKey: null,
    cursorScope,
    provider: null,
  });
  const localCommittedCursorRef = useRef(0);
  const eventQueueRef = useRef<QueuedEvent[]>([]);
  const preSyncTextSnapshotRef = useRef<QueuedEvent | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processingRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processingRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processingFailureAttemptRef = useRef(0);
  const processingFailureBoundaryRef = useRef<number | null>(null);
  const activeConnectionRef = useRef<ActiveDetailConnection | null>(null);

  const clearTimersAndQueue = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    if (processingRetryTimerRef.current) clearTimeout(processingRetryTimerRef.current);
    if (processingRecoveryTimerRef.current) clearTimeout(processingRecoveryTimerRef.current);
    flushTimerRef.current = null;
    drainTimerRef.current = null;
    processingRetryTimerRef.current = null;
    processingRecoveryTimerRef.current = null;
    eventQueueRef.current.length = 0;
    preSyncTextSnapshotRef.current = null;
  }, []);

  const disconnectActiveConnection = useCallback((generation: number) => {
    const activeConnection = activeConnectionRef.current;
    if (!activeConnection || activeConnection.generation !== generation) return;
    activeConnectionRef.current = null;
    activeConnection.disconnect();
  }, []);

  const committedCursor = useCallback((
    store: DetailCursorStore | undefined,
    scope: string,
    key: string,
  ): number => store?.get(scope, key) ?? localCommittedCursorRef.current, []);

  const commitCursor = useCallback((
    store: DetailCursorStore | undefined,
    scope: string,
    key: string,
    cursor: number,
  ): number => {
    if (store) return store.commit(scope, key, cursor);
    if (Number.isFinite(cursor) && cursor > localCommittedCursorRef.current) {
      localCommittedCursorRef.current = cursor;
    }
    return localCommittedCursorRef.current;
  }, []);

  const drainQueue = useCallback(() => {
    const generation = generationRef.current;
    const queue = eventQueueRef.current;
    while (queue.length > 0 && queue[0].generation !== generation) queue.shift();
    if (queue.length === 0) return;

    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;

    const chunk: QueuedEvent[] = [];
    while (chunk.length < BATCH_SIZE && queue[0]?.generation === generation) {
      chunk.push(queue.shift()!);
    }
    if (chunk.length === 0) return;

    const source = sourceRef.current;
    const key = source.sessionKey;
    if (!key) return;

    const resetMarkerIndex = chunk.findIndex(
      (item) => item.event.type === "history_sync" && item.event.reset_required === true,
    );
    const resetMarker = resetMarkerIndex >= 0 ? chunk[resetMarkerIndex] : undefined;
    const preservedSnapshot = preSyncTextSnapshotRef.current?.generation === generation
      ? preSyncTextSnapshotRef.current
      : null;
    const eventsToProcess = resetMarker
      ? [
          ...(preservedSnapshot
            ? [{ event: preservedSnapshot.event, eventId: preservedSnapshot.eventId }]
            : []),
          ...chunk.slice(resetMarkerIndex).map(({ event, eventId }) => ({ event, eventId })),
        ]
      : chunk.map(({ event, eventId }) => ({ event, eventId }));
    if (resetMarker) {
      clearTreeRef.current();
      useDashboardStore.setState((state) => ({
        historyResetVersion: state.historyResetVersion + 1,
      }));
    }

    try {
      processEventsRef.current(
        eventsToProcess,
      );
    } catch (error) {
      console.error("[useSessionProvider] Failed to process detail events:", error);
      // processEvents mutates its tree/context before committing the Zustand
      // projection, so a thrown chunk cannot safely share either that context
      // or its physical stream with later events. Fence the callback now (the
      // effect cleanup may run later), reset the durable history buffer, and
      // reconnect from the unchanged provider-owned committed cursor.
      const failedBoundary = chunk.reduce((boundary, item) => {
        const historyBoundary = item.event.type === "history_sync"
          ? item.event.last_event_id ?? 0
          : 0;
        return Math.max(boundary, item.eventId, historyBoundary);
      }, 0);
      processingFailureBoundaryRef.current = Math.max(
        processingFailureBoundaryRef.current ?? 0,
        failedBoundary,
      );
      if (processingRecoveryTimerRef.current) {
        clearTimeout(processingRecoveryTimerRef.current);
        processingRecoveryTimerRef.current = null;
      }
      disconnectActiveConnection(generation);
      generationRef.current += 1;
      clearTimersAndQueue();
      clearTreeRef.current();
      useDashboardStore.setState((state) => ({
        historyResetVersion: state.historyResetVersion + 1,
      }));
      setSynchronizedSessionKey(null);
      setStatus("error");
      const retryGeneration = generationRef.current;
      const retryDelay = Math.min(
        PROCESSING_RETRY_BASE_MS
          * 2 ** Math.min(processingFailureAttemptRef.current, 5),
        PROCESSING_RETRY_MAX_MS,
      );
      processingFailureAttemptRef.current += 1;
      processingRetryTimerRef.current = setTimeout(() => {
        processingRetryTimerRef.current = null;
        if (generationRef.current !== retryGeneration) return;
        setReconnectVersion((value) => value + 1);
      }, retryDelay);
      return;
    }
    const store = source.provider?.detailCursorStore;
    let maxCursor = committedCursor(store, source.cursorScope, key);
    let sawHistorySync = false;
    for (const item of chunk) {
      if (item.eventId > maxCursor) maxCursor = item.eventId;
      if (item.event.type === "history_sync") {
        sawHistorySync = true;
        maxCursor = Math.max(maxCursor, item.event.last_event_id ?? 0);
      }
    }
    commitCursor(store, source.cursorScope, key, maxCursor);

    const failedBoundary = processingFailureBoundaryRef.current;
    if (failedBoundary !== null && failedBoundary > 0 && maxCursor >= failedBoundary) {
      processingFailureAttemptRef.current = 0;
      processingFailureBoundaryRef.current = null;
      if (processingRecoveryTimerRef.current) {
        clearTimeout(processingRecoveryTimerRef.current);
        processingRecoveryTimerRef.current = null;
      }
    } else if (failedBoundary === 0 && !processingRecoveryTimerRef.current) {
      const recoveryGeneration = generationRef.current;
      processingRecoveryTimerRef.current = setTimeout(() => {
        processingRecoveryTimerRef.current = null;
        if (generationRef.current !== recoveryGeneration) return;
        processingFailureAttemptRef.current = 0;
        processingFailureBoundaryRef.current = null;
      }, PROCESSING_RECOVERY_STABLE_MS);
    }

    if (sawHistorySync && generationRef.current === generation) {
      preSyncTextSnapshotRef.current = null;
      setSynchronizedSessionKey(key);
    }

    if (queue[0]?.generation === generation) {
      drainTimerRef.current = setTimeout(() => {
        drainTimerRef.current = null;
        drainQueue();
      }, 0);
    }
  }, [clearTimersAndQueue, commitCursor, committedCursor, disconnectActiveConnection]);

  const enqueueEvent = useCallback((
    event: SoulSSEEvent,
    eventId: number,
    generation: number,
  ) => {
    if (generation !== generationRef.current) return;
    const queued = { event, eventId, generation };
    if (event.type === "text_snapshot") preSyncTextSnapshotRef.current = queued;
    eventQueueRef.current.push(queued);
    if (eventQueueRef.current.length >= BATCH_SIZE) {
      drainQueue();
      return;
    }
    if (!flushTimerRef.current && !drainTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        drainQueue();
      }, BATCH_FLUSH_MS);
    }
  }, [drainQueue]);

  useEffect(() => {
    const previous = sourceRef.current;
    const sourceChanged = previous.sessionKey !== sessionKey
      || previous.cursorScope !== cursorScope;

    generationRef.current += 1;
    const generation = generationRef.current;
    clearTimersAndQueue();

    if (sourceChanged) {
      processingFailureAttemptRef.current = 0;
      processingFailureBoundaryRef.current = null;
      if (previous.cursorScope !== cursorScope) {
        previous.provider?.detailCursorStore?.clearScope(previous.cursorScope);
      }
      clearTree();
      localCommittedCursorRef.current = 0;
      setSynchronizedSessionKey(null);
    }

    if (!sessionKey || !active) {
      processingFailureAttemptRef.current = 0;
      processingFailureBoundaryRef.current = null;
      sourceRef.current = { sessionKey, cursorScope, provider: previous.provider };
      setStatus("disconnected");
      setSynchronizedSessionKey(null);
      return;
    }

    const provider = getSessionProvider();
    sourceRef.current = { sessionKey, cursorScope, provider };
    const store = provider.detailCursorStore;
    const initialLastEventId = committedCursor(store, cursorScope, sessionKey);
    setStatus("connecting");
    setSynchronizedSessionKey(null);

    void provider.fetchCards(sessionKey).then((cards) => {
      if (generation !== generationRef.current || cards.length === 0) return;
      const batch: Array<{ event: SoulSSEEvent; eventId: number }> = [];
      for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        if (card.type === "text") {
          batch.push({ event: { type: "text_start", timestamp: 0 }, eventId: index * 3 });
          batch.push({
            event: { type: "text_delta", timestamp: 0, text: card.content },
            eventId: index * 3 + 1,
          });
          batch.push({ event: { type: "text_end", timestamp: 0 }, eventId: index * 3 + 2 });
        } else if (card.type === "tool") {
          batch.push({
            event: {
              type: "tool_start",
              timestamp: 0,
              tool_name: card.toolName,
              tool_input: card.toolInput,
              tool_use_id: card.toolUseId,
              parent_event_id: card.parentEventId,
            },
            eventId: index * 3,
          });
          if (card.completed) {
            batch.push({
              event: {
                type: "tool_result",
                timestamp: 0,
                tool_name: card.toolName,
                result: card.toolResult ?? "",
                is_error: card.isError ?? false,
                tool_use_id: card.toolUseId,
                parent_event_id: card.parentEventId,
              },
              eventId: index * 3 + 1,
            });
          }
        }
      }
      if (batch.length > 0 && generation === generationRef.current) {
        processEventsRef.current(batch);
      }
    }).catch((error: unknown) => {
      if (generation !== generationRef.current) return;
      console.error("[useSessionProvider] Failed to load initial cards:", error);
    });

    const handleStatus = (nextStatus: "connecting" | "connected" | "error") => {
      if (generation !== generationRef.current) return;
      if (nextStatus === "connecting") {
        // Every physical connection starts with replay/snapshot. Suppress raw
        // detail notifications until its history_sync marker; the global feed
        // stream remains the canonical all-session notification plane.
        useDashboardStore.getState().processingCtx.historySynced = false;
      }
      setStatus(nextStatus);
    };

    let unsubscribe: (() => void) | null = null;
    let disconnectRequested = false;
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnectRequested = true;
      if (!unsubscribe) return;
      disconnected = true;
      const close = unsubscribe;
      unsubscribe = null;
      close();
    };
    activeConnectionRef.current = { generation, disconnect };

    unsubscribe = provider.subscribe(
      sessionKey,
      (event, eventId) => enqueueEvent(event, eventId, generation),
      handleStatus,
      {
        lastEventId: initialLastEventId,
        getLastEventId: () => committedCursor(store, cursorScope, sessionKey),
      },
    );
    if (disconnectRequested) disconnect();

    return () => {
      disconnectActiveConnection(generation);
      generationRef.current += 1;
      clearTimersAndQueue();
    };
  // getSessionProvider callbacks are commonly inline. cursorScope is the explicit source identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    clearTimersAndQueue,
    clearTree,
    committedCursor,
    cursorScope,
    disconnectActiveConnection,
    enqueueEvent,
    reconnectVersion,
    sessionKey,
  ]);

  const reconnect = useCallback(() => {
    if (!sessionKey) return;
    processingFailureAttemptRef.current = 0;
    processingFailureBoundaryRef.current = null;
    if (processingRetryTimerRef.current) {
      clearTimeout(processingRetryTimerRef.current);
      processingRetryTimerRef.current = null;
    }
    if (processingRecoveryTimerRef.current) {
      clearTimeout(processingRecoveryTimerRef.current);
      processingRecoveryTimerRef.current = null;
    }
    setSynchronizedSessionKey(null);
    setReconnectVersion((value) => value + 1);
  }, [sessionKey]);

  return { status, reconnect, synchronizedSessionKey };
}
