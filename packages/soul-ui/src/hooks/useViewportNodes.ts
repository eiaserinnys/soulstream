/**
 * useViewportNodes — Viewport API 이벤트를 로컬 상태로 관리하는 훅
 *
 * 서버의 viewport API 응답에서 events를 받아 GraphNode/GraphEdge로 변환하고,
 * SSE 라이브 이벤트를 viewport 범위 내이면 즉시 추가한다.
 *
 * 책임:
 *  - viewport API 호출 → events + totalSubtreeHeight 수신
 *  - events → GraphNode/GraphEdge 변환 (viewport-graph-builder 위임)
 *  - 세션 전환 시 초기화 + 초기 fetch
 *  - pan/zoom 시 200ms 트로틀 refetch
 *  - SSE 재연결 시 viewport 재fetch 트리거
 */

import { useState, useCallback, useRef, useEffect } from "react";

import {
  buildViewportGraph,
  type ViewportEvent,
} from "../lib/viewport-graph-builder";
import type { GraphNode, GraphEdge } from "../lib/layout-engine";
import { useDashboardStore } from "../stores/dashboard-store";
import { runTailAnchoredFetch } from "./useViewportNodes.tail-helpers";

export interface ViewportRange {
  yStart: number;
  yEnd: number;
}

export interface UseViewportNodesResult {
  /** 현재 viewport 범위의 React Flow 노드 */
  nodes: GraphNode[];
  /** 현재 viewport 범위의 React Flow 엣지 */
  edges: GraphEdge[];
  /** viewport 이벤트 원본 (디버깅용) */
  events: ViewportEvent[];
  /** 로딩 중 여부 */
  isLoading: boolean;
  /** viewport fetch를 트리거한다 (pan/zoom 시 호출) */
  fetchViewport: (range: ViewportRange) => void;
  /** viewport 강제 재fetch (SSE 재연결 시) */
  refetch: () => void;
}

/**
 * Viewport API 이벤트를 관리하는 훅.
 *
 * @param sessionKey - 세션 식별자 (null이면 비활성)
 */
export function useViewportNodes(
  sessionKey: string | null,
): UseViewportNodesResult {
  const [events, setEvents] = useState<ViewportEvent[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const setTotalSubtreeHeight = useDashboardStore(
    (s) => s.setTotalSubtreeHeight,
  );

  // 마지막 fetch된 범위 (refetch 시 동일 범위 재요청용)
  const lastRangeRef = useRef<ViewportRange | null>(null);
  // 현재 진행 중인 fetch의 AbortController (중복 요청 방지)
  const abortRef = useRef<AbortController | null>(null);

  // viewport API fetch 함수
  const doFetch = useCallback(
    async (range: ViewportRange) => {
      if (!sessionKey) return;

      // 이전 요청 취소
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      lastRangeRef.current = range;

      const qs = new URLSearchParams({
        y_min: String(Math.max(1, Math.floor(range.yStart))),
        y_max: String(Math.max(1, Math.ceil(range.yEnd))),
      });

      try {
        setIsLoading(true);
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionKey)}/events/viewport?${qs}`,
          { credentials: "include", signal: controller.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          events: ViewportEvent[];
          total_subtree_height: number;
        };

        if (controller.signal.aborted) return;

        const viewportEvents = data.events ?? [];
        setEvents(viewportEvents);

        // totalSubtreeHeight를 store에 반영 (서버 정본)
        if (typeof data.total_subtree_height === "number") {
          setTotalSubtreeHeight(data.total_subtree_height);
        }

        // events → GraphNode/GraphEdge 변환
        const { nodes: newNodes, edges: newEdges } =
          buildViewportGraph(viewportEvents);
        setNodes(newNodes);
        setEdges(newEdges);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // 네트워크 오류는 무시 — SSE 라이브 파이프라인이 보조한다
        console.warn("[useViewportNodes] fetch failed:", err);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [sessionKey, setTotalSubtreeHeight],
  );

  // 외부 호출용 fetch 트리거
  const fetchViewport = useCallback(
    (range: ViewportRange) => {
      void doFetch(range);
    },
    [doFetch],
  );

  // SSE 재연결 시 마지막 범위로 재fetch
  const refetch = useCallback(() => {
    if (lastRangeRef.current) {
      void doFetch(lastRangeRef.current);
    }
  }, [doFetch]);

  // 세션 전환 시 tail-anchoring 2단계 fetch:
  //  1단계: y_max=1로 total_subtree_height만 획득 (nodes/edges는 설정 안 해서 중간 플래시 방지)
  //  2단계: tail 범위 max(1, total-49) ~ total 로 실제 fetch
  // total <= 50이면 1단계의 total을 기반으로 yStart=1 유지.
  //
  // AbortController 소유권:
  //  - probe가 abortRef에 임시로 등록 → 이후 doFetch 호출이 abortRef를 자연스럽게 교체.
  //  - cleanup은 기존과 동일한 abortRef.current?.abort() 한 줄로 양 단계 모두 취소 가능.
  useEffect(() => {
    if (!sessionKey) {
      setEvents([]);
      setNodes([]);
      setEdges([]);
      lastRangeRef.current = null;
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    void runTailAnchoredFetch({
      sessionKey,
      fetchImpl: fetch,
      signal: controller.signal,
      setTotalSubtreeHeight,
      doFetch: (range) => {
        void doFetch(range);
      },
    });

    return () => {
      abortRef.current?.abort();
      setIsLoading(false);
    };
  }, [sessionKey, doFetch, setTotalSubtreeHeight]);

  return {
    nodes,
    edges,
    events,
    isLoading,
    fetchViewport,
    refetch,
  };
}
