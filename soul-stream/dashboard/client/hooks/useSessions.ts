/**
 * SSE 훅 — /api/sessions 에서 전체 세션 목록을 폴링.
 */

import { useEffect, useRef } from "react";
import { useOrchestratorStore } from "../store/orchestrator-store";
import type { OrchestratorSession } from "../store/types";

const POLL_INTERVAL = 5000;

export function useSessions() {
  const setNodeSessions = useOrchestratorStore((s) => s.setNodeSessions);

  // nodes 변경을 ref로 추적 — useEffect 의존성에서 제외하여 interval 재생성 방지
  const nodesRef = useRef(useOrchestratorStore.getState().nodes);
  useEffect(() => {
    return useOrchestratorStore.subscribe((state) => {
      nodesRef.current = state.nodes;
    });
  }, []);

  useEffect(() => {
    let active = true;

    async function fetchSessions() {
      if (!active) return;
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return;
        const data: {
          sessions: Array<{
            sessionId: string;
            nodeId: string;
            summary: {
              status?: string;
              lastMessage?: unknown;
              updatedAt?: string;
              createdAt?: string;
              prompt?: string;
            };
          }>;
        } = await res.json();

        // 노드별로 그룹핑
        const grouped = new Map<string, OrchestratorSession[]>();
        for (const s of data.sessions) {
          const list = grouped.get(s.nodeId) ?? [];
          const rawLm = s.summary.lastMessage;
          const lastMessage =
            rawLm && typeof rawLm === "object"
              ? (rawLm as { preview?: string; timestamp?: string; type?: string })
              : undefined;
          list.push({
            sessionId: s.sessionId,
            nodeId: s.nodeId,
            status: (s.summary.status ?? "completed") as OrchestratorSession["status"],
            lastMessage,
            updatedAt: s.summary.updatedAt,
            createdAt: s.summary.createdAt,
            prompt: s.summary.prompt,
          });
          grouped.set(s.nodeId, list);
        }

        // 연결된 노드 중 세션이 없는 노드도 빈 배열로 설정
        for (const nodeId of nodesRef.current.keys()) {
          if (!grouped.has(nodeId)) {
            grouped.set(nodeId, []);
          }
        }

        for (const [nodeId, sessions] of grouped) {
          setNodeSessions(nodeId, sessions);
        }
      } catch {
        // 네트워크 에러 — 다음 폴링에서 재시도
      }
    }

    fetchSessions();
    const id = setInterval(fetchSessions, POLL_INTERVAL);

    return () => {
      active = false;
      clearInterval(id);
    };
  }, [setNodeSessions]);
}
