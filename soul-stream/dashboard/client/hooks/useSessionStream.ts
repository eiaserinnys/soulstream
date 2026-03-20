/**
 * useSessionStream — ChatPanel용 SSE 세션 이벤트 구독 훅.
 *
 * soul-dashboard의 useSessionProvider.ts 패턴을 따르되, 오케스트레이터에 맞게 조정:
 * - orchestrator-store의 selectedSessionId를 dashboard-store의 activeSessionKey로 동기화
 * - SoulstreamSessionProvider를 통해 SSE 구독 + 배치 이벤트 처리
 * - 세션 종료(status 변경)로는 SSE 연결을 닫지 않음 (다른 서버에서 후속 메시지 가능)
 *   → useEffect deps에 selectedSessionId만 포함하므로 status 변경은 cleanup을 트리거하지 않음
 */

import { useEffect, useState, useCallback, useRef } from "react";
import {
  useDashboardStore,
  BATCH_SIZE,
  BATCH_FLUSH_MS,
} from "@seosoyoung/soul-ui";
import type { SoulSSEEvent, SessionSummary, SessionStatus } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { SoulstreamSessionProvider } from "../providers/SoulstreamSessionProvider";

/** 모듈 레벨 싱글턴 — 모든 구독이 하나의 Provider 인스턴스를 공유 */
const provider = new SoulstreamSessionProvider();

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface QueuedEvent {
  event: SoulSSEEvent;
  eventId: number;
}

/** OrchestratorSession.status → SessionSummary.status 매핑 */
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

  // --- 배치 처리 (useSessionProvider.ts L63-128 패턴) ---

  const eventQueueRef = useRef<QueuedEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processEventsRef = useRef(processEvents);

  // stale closure 방지
  useEffect(() => {
    processEventsRef.current = processEvents;
  }, [processEvents]);

  /** 큐를 BATCH_SIZE 청크 단위로 처리, 청크 간 yielding */
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

  /** 이벤트를 큐에 추가 */
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

  /** 타이머 + 큐 정리 */
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

  // --- 세션 정보 동기화: orchestrator-store → dashboard-store ---

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

  // --- 핵심 구독 effect ---

  useEffect(() => {
    if (!selectedSessionId) {
      setActiveSession(null);
      setStatus("disconnected");
      return;
    }

    // 1. dashboard-store에 활성 세션 설정
    setActiveSession(selectedSessionId);
    // 2. 이전 트리 클리어
    clearTree();
    // 3. SSE 구독 시작
    setStatus("connecting");
    const unsubscribe = provider.subscribe(
      selectedSessionId,
      (event, eventId) => enqueueEvent(event, eventId),
      setStatus,
    );

    // cleanup: 세션 전환 또는 컴포넌트 언마운트 시에만 실행
    // 세션 상태(running→completed)가 변해도 deps가 바뀌지 않으므로 cleanup 미실행 → SSE 유지
    return () => {
      clearTimersAndQueue();
      unsubscribe();
      setStatus("disconnected");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  return { status };
}
