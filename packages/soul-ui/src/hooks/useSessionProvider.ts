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

export function useSessionProvider(options: UseSessionProviderOptions) {
  const {
    sessionKey,
    cursorScope,
    active = true,
    getSessionProvider,
  } = options;

  const processEvents = useDashboardStore((state) => state.processEvents);
  const clearTree = useDashboardStore((state) => state.clearTree);
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
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimersAndQueue = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    flushTimerRef.current = null;
    drainTimerRef.current = null;
    eventQueueRef.current.length = 0;
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

    try {
      processEventsRef.current(
        chunk.map(({ event, eventId }) => ({ event, eventId })),
      );
    } catch (error) {
      console.error("[useSessionProvider] Failed to process detail events:", error);
      setStatus("error");
      eventQueueRef.current.length = 0;
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

    if (sawHistorySync && generationRef.current === generation) {
      setSynchronizedSessionKey(key);
    }

    if (queue[0]?.generation === generation) {
      drainTimerRef.current = setTimeout(() => {
        drainTimerRef.current = null;
        drainQueue();
      }, 0);
    }
  }, [commitCursor, committedCursor]);

  const enqueueEvent = useCallback((
    event: SoulSSEEvent,
    eventId: number,
    generation: number,
  ) => {
    if (generation !== generationRef.current) return;
    eventQueueRef.current.push({ event, eventId, generation });
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
      if (previous.cursorScope !== cursorScope) {
        previous.provider?.detailCursorStore?.clearScope(previous.cursorScope);
      }
      clearTree();
      localCommittedCursorRef.current = 0;
      setSynchronizedSessionKey(null);
    }

    if (!sessionKey || !active) {
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
      setStatus(nextStatus);
    };

    const unsubscribe = provider.subscribe(
      sessionKey,
      (event, eventId) => enqueueEvent(event, eventId, generation),
      handleStatus,
      {
        lastEventId: initialLastEventId,
        getLastEventId: () => committedCursor(store, cursorScope, sessionKey),
      },
    );

    return () => {
      generationRef.current += 1;
      clearTimersAndQueue();
      unsubscribe();
    };
  // getSessionProvider callbacks are commonly inline. cursorScope is the explicit source identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    clearTimersAndQueue,
    clearTree,
    committedCursor,
    cursorScope,
    enqueueEvent,
    reconnectVersion,
    sessionKey,
  ]);

  const reconnect = useCallback(() => {
    if (!sessionKey) return;
    setSynchronizedSessionKey(null);
    setReconnectVersion((value) => value + 1);
  }, [sessionKey]);

  return { status, reconnect, synchronizedSessionKey };
}
