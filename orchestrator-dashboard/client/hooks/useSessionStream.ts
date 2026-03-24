/**
 * useSessionStream — ChatPanel용 SSE 세션 이벤트 구독 훅.
 *
 * orchestrator-store의 selectedSessionId를 dashboard-store의 activeSessionKey로 동기화.
 * soul-ui sseSessionProvider를 통해 SSE 구독 + 배치 이벤트 처리.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import {
  useDashboardStore,
  sseSessionProvider as provider,
  BATCH_SIZE,
  BATCH_FLUSH_MS,
} from "@seosoyoung/soul-ui";
import type { SoulSSEEvent, SessionSummary, SessionStatus } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface QueuedEvent {
  event: SoulSSEEvent;
  eventId: number;
}

function mapSessionStatus(status: string): SessionStatus {
  if (status === "idle") return "unknown";
  return status as SessionStatus;
}

export function useSessionStream() {
  const selectedSessionId = useOrchestratorStore((s) => s.selectedSessionId);
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const orchSessions = useOrchestratorStore((s) => s.sessions);

  const processEvents = useDashboardStore((s) => s.processEvents);
  const clearTree = useDashboardStore((s) => s.clearTree);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  const eventQueueRef = useRef<QueuedEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processEventsRef = useRef(processEvents);

  useEffect(() => {
    processEventsRef.current = processEvents;
  }, [processEvents]);

  const drainQueue = useCallback(() => {
    const queue = eventQueueRef.current;
    if (queue.length === 0) return;

    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const chunk = queue.splice(0, BATCH_SIZE);
    processEventsRef.current(chunk);

    if (queue.length > 0) {
      drainTimerRef.current = setTimeout(() => {
        drainTimerRef.current = null;
        drainQueue();
      }, 0);
    }
  }, []);

  const enqueueEvent = useCallback(
    (event: SoulSSEEvent, eventId: number) => {
      eventQueueRef.current.push({ event, eventId });

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
    },
    [drainQueue],
  );

  const clearTimersAndQueue = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (drainTimerRef.current) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    eventQueueRef.current.length = 0;
  }, []);

  // orchestrator-store → dashboard-store 세션 정보 동기화
  useEffect(() => {
    if (!selectedNodeId || !selectedSessionId) {
      useDashboardStore.getState().setSessions([], 0);
      return;
    }
    const nodeSessions = orchSessions.get(selectedNodeId) ?? [];
    const summaries: SessionSummary[] = nodeSessions.map((s) => ({
      agentSessionId: s.sessionId,
      status: mapSessionStatus(s.status),
      prompt: s.prompt ?? "",
      createdAt: s.createdAt ?? "",
      eventCount: 0,
    }));
    useDashboardStore.getState().setSessions(summaries, summaries.length);
  }, [selectedNodeId, selectedSessionId, orchSessions]);

  useEffect(() => {
    if (!selectedSessionId) {
      setActiveSession(null);
      setStatus("disconnected");
      return;
    }

    setActiveSession(selectedSessionId);
    clearTree();
    setStatus("connecting");
    const unsubscribe = provider.subscribe(
      selectedSessionId,
      (event, eventId) => enqueueEvent(event, eventId),
      setStatus,
    );

    return () => {
      clearTimersAndQueue();
      unsubscribe();
      setStatus("disconnected");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  return { status };
}
