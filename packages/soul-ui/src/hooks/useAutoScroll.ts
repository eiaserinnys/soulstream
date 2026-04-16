/**
 * useAutoScroll — NodeGraph 자동 스크롤(pan) 동작 관리
 *
 * 책임:
 *  - autoScroll 플래그 상태 (세션 변경 시 ON으로 리셋)
 *  - 사용자 수동 이동 감지 → autoScroll OFF
 *  - autoScroll 토글 ON 시 즉시 마지막 노드로 pan
 *  - 신규 노드/최초 로드 시 호출되는 pan 헬퍼 제공
 *  - lastNodeRef 보유 (그래프 빌더가 갱신)
 *
 * pan 로직은 줌을 변경하지 않고 dx/dy만 산출한다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";

import {
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  type GraphNode,
} from "../lib/layout-engine";

/** 고정 줌 비율 (Complete 상태 기준) */
export const FIXED_ZOOM = 0.9;

/** 최소 줌 비율 (ReactFlow minZoom과 동기화) */
export const MIN_ZOOM = 0.1;

/** 뷰포트 가장자리와 새 노드 사이의 최소 마진 (px) */
const PAN_MARGIN = 80;

/**
 * 특정 노드가 뷰포트에 보이도록 하기 위해 필요한 pan(dx, dy)을 계산합니다.
 * 줌은 절대 변경하지 않습니다. 이미 보이면 { dx: 0, dy: 0 }을 반환합니다.
 */
export function calcPanToNode(
  node: GraphNode,
  viewport: { x: number; y: number; zoom: number },
  vpW: number,
  vpH: number,
): { dx: number; dy: number } {
  const { zoom } = viewport;
  const screenX = node.position.x * zoom + viewport.x;
  const screenY = node.position.y * zoom + viewport.y;
  const nodeW = (node.width ?? DEFAULT_NODE_WIDTH) * zoom;
  const nodeH = (node.height ?? DEFAULT_NODE_HEIGHT) * zoom;

  if (
    screenX + nodeW > PAN_MARGIN &&
    screenX < vpW - PAN_MARGIN &&
    screenY + nodeH > PAN_MARGIN &&
    screenY < vpH - PAN_MARGIN
  ) {
    return { dx: 0, dy: 0 };
  }

  let dx = 0;
  let dy = 0;

  if (screenX + nodeW <= PAN_MARGIN) {
    dx = PAN_MARGIN - screenX;
  } else if (screenX >= vpW - PAN_MARGIN) {
    dx = vpW - PAN_MARGIN - nodeW - screenX;
    if (nodeW > vpW - 2 * PAN_MARGIN) {
      dx = PAN_MARGIN - screenX;
    }
  }

  if (screenY + nodeH <= PAN_MARGIN) {
    dy = PAN_MARGIN - screenY;
  } else if (screenY >= vpH - PAN_MARGIN) {
    dy = vpH - PAN_MARGIN - nodeH - screenY;
    if (nodeH > vpH - 2 * PAN_MARGIN) {
      dy = PAN_MARGIN - screenY;
    }
  }

  return { dx, dy };
}

export interface UseAutoScrollResult {
  autoScroll: boolean;
  /** ReactFlow onMoveEnd 핸들러 — 사용자 수동 이동 감지용 */
  onMoveEnd: (event: MouseEvent | TouchEvent | null) => void;
  /** 토글 버튼 핸들러 — ON 전환 시 lastNode로 즉시 pan */
  handleToggleAutoScroll: () => void;
  /** 그래프 빌더가 마지막 노드 참조를 갱신할 때 호출 */
  setLastNode: (node: GraphNode | null) => void;
  /**
   * 현재 뷰포트에서 대상 노드로 pan (줌 불변).
   * 노드가 이미 보이면 아무것도 하지 않는다.
   * autoScroll 플래그를 자체적으로 검사하지 않으므로, 호출자가 분기한다.
   */
  panToNode: (node: GraphNode) => void;
  /**
   * 최초 로드용 pan — 뷰포트를 (0, 0, FIXED_ZOOM)로 초기화한 뒤 노드 기준으로 pan.
   */
  panOnFirstLoad: (node: GraphNode) => void;
}

export function useAutoScroll(activeSessionKey: string | null): UseAutoScrollResult {
  const { getViewport, setViewport } = useReactFlow();
  const store = useStoreApi();

  // 자동 스크롤 상태 (기본 ON)
  const [autoScroll, setAutoScroll] = useState(true);
  // 프로그래밍적 뷰포트 이동을 구분하기 위한 플래그
  const isProgrammaticMoveRef = useRef(false);
  // 현재 그래프의 마지막 노드 참조 (토글 ON 시 즉시 이동용)
  const lastNodeRef = useRef<GraphNode | null>(null);

  // 세션 변경 시 auto-scroll 리셋
  useEffect(() => {
    setAutoScroll(true);
  }, [activeSessionKey]);

  // 사용자 수동 이동 감지 → auto-scroll OFF
  const onMoveEnd = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      // event가 null이면 프로그래밍적 이동
      if (event && !isProgrammaticMoveRef.current) {
        setAutoScroll(false);
      }
      isProgrammaticMoveRef.current = false;
    },
    [],
  );

  // auto-scroll 토글 ON → 즉시 마지막 노드로 이동
  const handleToggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev;
      if (next && lastNodeRef.current) {
        const { width: vpW, height: vpH } = store.getState();
        if (vpW === 0 || vpH === 0) return next;
        const viewport = getViewport();
        const { dx, dy } = calcPanToNode(lastNodeRef.current, viewport, vpW, vpH);
        if (dx !== 0 || dy !== 0) {
          isProgrammaticMoveRef.current = true;
          setViewport(
            { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom },
            { duration: 300 },
          );
        }
      }
      return next;
    });
  }, [getViewport, setViewport, store]);

  const setLastNode = useCallback((node: GraphNode | null) => {
    lastNodeRef.current = node;
  }, []);

  const panToNode = useCallback(
    (node: GraphNode) => {
      const { width: vpW, height: vpH } = store.getState();
      if (vpW === 0 || vpH === 0) return;
      const viewport = getViewport();
      const { dx, dy } = calcPanToNode(node, viewport, vpW, vpH);
      if (dx === 0 && dy === 0) return;
      isProgrammaticMoveRef.current = true;
      setViewport(
        { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom },
        { duration: 300 },
      );
    },
    [getViewport, setViewport, store],
  );

  const panOnFirstLoad = useCallback(
    (node: GraphNode) => {
      const { width: vpW, height: vpH } = store.getState();
      if (vpW === 0 || vpH === 0) return;
      const viewport = { x: 0, y: 0, zoom: FIXED_ZOOM };
      const { dx, dy } = calcPanToNode(node, viewport, vpW, vpH);
      isProgrammaticMoveRef.current = true;
      setViewport(
        { x: viewport.x + dx, y: viewport.y + dy, zoom: FIXED_ZOOM },
        { duration: 300 },
      );
    },
    [setViewport, store],
  );

  return {
    autoScroll,
    onMoveEnd,
    handleToggleAutoScroll,
    setLastNode,
    panToNode,
    panOnFirstLoad,
  };
}
