/**
 * 폴링 훅 — /api/catalog 에서 전체 세션 목록을 주기적으로 조회.
 *
 * Phase 2에서 구현된 BFF DB 직접 엔드포인트를 사용한다.
 * soul-stream에 /api/sessions/stream 엔드포인트가 없으므로 SSE 방식 불가 — 30초 폴링 사용.
 */

import { useEffect, useRef } from "react";
import { useOrchestratorStore } from "../store/orchestrator-store";
import type { OrchestratorSession } from "../store/types";

const CATALOG_POLL_INTERVAL = 30_000;

export function useSessions() {
  const setNodeSessions = useOrchestratorStore((s) => s.setNodeSessions);

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
        const res = await fetch("/api/catalog");
        if (!res.ok) return;
        const data: {
          sessions: Array<{
            id: number;
            session_id: string;
            node_id: string;
            folder_id: string | null;
            status: string;
            created_at: string;
            updated_at: string | null;
          }>;
        } = await res.json();

        // 노드별로 그룹핑
        const grouped = new Map<string, OrchestratorSession[]>();
        for (const s of data.sessions) {
          const list = grouped.get(s.node_id) ?? [];
          list.push({
            sessionId: s.session_id,
            nodeId: s.node_id,
            status: s.status as OrchestratorSession["status"],
            updatedAt: s.updated_at ?? undefined,
            createdAt: s.created_at,
            // lastMessage, prompt: catalog 응답에 없음 (OrchestratorSession에서 optional)
          });
          grouped.set(s.node_id, list);
        }

        // 연결된 노드 중 세션이 없는 노드도 빈 배열로 설정 (NodePanel 렌더링 오류 방지)
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
    const id = setInterval(fetchSessions, CATALOG_POLL_INTERVAL);

    return () => {
      active = false;
      clearInterval(id);
    };
  }, [setNodeSessions]);
}
