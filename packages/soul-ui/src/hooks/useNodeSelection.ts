/**
 * useNodeSelection — NodeGraph 선택 상태 동기화
 *
 * 책임:
 *  - ReactFlow onSelectionChange → selectCard/selectEventNode 라우팅 (nodeType 기반)
 *  - 같은 노드 재클릭 시 chat → detail 탭 전환 (onNodeClick)
 *  - 프로그래밍적 선택 변경 시 탭 전환 억제 (isProgrammaticSelectRef)
 *  - 그래프 빌더가 자동 선택할 때 사용하는 헬퍼 제공 (follow / first-load 분기)
 *
 * dashboard-store의 선택 변경을 ReactFlow 노드 `selected`에 반영하는 동기화는
 * 별도의 useNodesSelectedSync 훅으로 분리되어 있다 (setNodes 의존을 격리).
 */

import { useCallback, useEffect, useRef } from "react";
import type { OnSelectionChangeParams } from "@xyflow/react";

import {
  useDashboardStore,
  type SelectedEventNodeData,
} from "../stores/dashboard-store";
import {
  type GraphNode,
  type GraphNodeData,
} from "../lib/layout-engine";

/** selectEventNode 경로로 라우팅하는 노드 타입 (트리 조회 불필요, 데이터 직접 전달) */
export const EVENT_NODE_TYPES = new Set(["user", "intervention", "system", "result"]);

/** 그래프 노드 데이터에서 이벤트 노드 선택 데이터를 추출합니다. */
export function buildEventNodeData(nodeData: GraphNodeData): SelectedEventNodeData {
  return {
    nodeType: nodeData.nodeType as SelectedEventNodeData["nodeType"],
    label: nodeData.label,
    content: nodeData.fullContent ?? nodeData.content ?? "",
    durationMs: nodeData.durationMs,
    usage: nodeData.usage,
    totalCostUsd: nodeData.totalCostUsd,
    isError: nodeData.isError,
  };
}

export interface UseNodeSelectionResult {
  /** ReactFlow onSelectionChange 핸들러 */
  onSelectionChange: (params: OnSelectionChangeParams) => void;
  /** ReactFlow onNodeClick 핸들러 (재클릭 탭 전환) */
  onNodeClick: () => void;
  /**
   * Follow/incremental: 매칭 핸들러가 없을 때도 isProgrammaticSelectRef를 true로 유지한다.
   * (원본 NodeGraph follow/incremental 분기와 동일)
   */
  selectGraphNodeForFollow: (node: GraphNode) => void;
  /**
   * 최초 로드: 매칭 핸들러가 없으면 isProgrammaticSelectRef를 false로 복원한다.
   * (원본 NodeGraph 최초 로드 분기와 동일)
   */
  selectGraphNodeOnFirstLoad: (node: GraphNode) => void;
}

export function useNodeSelection(): UseNodeSelectionResult {
  const selectCard = useDashboardStore((s) => s.selectCard);
  const selectEventNode = useDashboardStore((s) => s.selectEventNode);

  // 프로그래밍적 선택 변경 시 onSelectionChange에서 탭 전환을 억제하기 위한 플래그
  const isProgrammaticSelectRef = useRef(false);

  // 노드 선택 → 카드 선택 또는 이벤트 노드 선택 동기화
  // nodeType 기반 라우팅: user/intervention/system/result → selectEventNode, 나머지 → selectCard
  // isProgrammaticSelectRef가 true이면 프로그래밍적 선택 변경이므로 탭 전환 억제
  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      const switchTab = !isProgrammaticSelectRef.current;
      isProgrammaticSelectRef.current = false;

      if (selectedNodes.length === 1) {
        const nodeData = selectedNodes[0].data as GraphNodeData;
        const nodeType = nodeData?.nodeType as string | undefined;

        // 이벤트 노드: 데이터 직접 전달 (트리 조회 불필요)
        if (nodeType && EVENT_NODE_TYPES.has(nodeType)) {
          selectEventNode(
            buildEventNodeData(nodeData),
            selectedNodes[0].id,
            switchTab,
          );
          return;
        }

        // 카드 노드: 트리 조회 기반 (thinking, tool_call)
        const cardId = nodeData?.cardId as string | undefined;
        if (cardId) {
          selectCard(cardId, selectedNodes[0].id, switchTab);
          return;
        }
      }
      // 노드 해제(deselect)에서는 탭 전환하지 않음
      // 세션 전환 시 노드가 클리어되면서 onSelectionChange가 호출되는데,
      // 이때 detail 탭으로 전환하면 사용자가 보고 있던 chat 탭이 초기화됨
      selectCard(null, null, false);
    },
    [selectCard, selectEventNode],
  );

  // 이미 선택된 노드를 재클릭해도 탭을 전환한다.
  // onSelectionChange는 이미 선택된 노드 재클릭 시 발화하지 않으므로,
  // 탭 전환만 별도로 처리한다. 노드 선택 자체는 onSelectionChange가 담당.
  const onNodeClick = useCallback(() => {
    const currentTab = useDashboardStore.getState().activeRightTab;
    if (currentTab === "chat") {
      useDashboardStore.getState().setActiveRightTab("detail");
    }
  }, []);

  // Follow/incremental: 매칭 없을 때 플래그를 복원하지 않음
  const selectGraphNodeForFollow = useCallback(
    (node: GraphNode) => {
      const nodeType = node.data.nodeType as string | undefined;
      const cardId = node.data.cardId as string | undefined;

      isProgrammaticSelectRef.current = true;
      if (nodeType && EVENT_NODE_TYPES.has(nodeType)) {
        selectEventNode(
          buildEventNodeData(node.data as GraphNodeData),
          node.id,
          false,
        );
      } else if (cardId) {
        selectCard(cardId, node.id, false);
      }
      // No else — 플래그는 true로 유지 (원본 NodeGraph follow/incremental 분기 동일)
    },
    [selectCard, selectEventNode],
  );

  // First-load: 매칭 없을 때 플래그를 false로 복원
  const selectGraphNodeOnFirstLoad = useCallback(
    (node: GraphNode) => {
      const nodeType = node.data.nodeType as string | undefined;

      isProgrammaticSelectRef.current = true;
      if (nodeType && EVENT_NODE_TYPES.has(nodeType)) {
        selectEventNode(
          buildEventNodeData(node.data as GraphNodeData),
          node.id,
          false,
        );
      } else {
        const cardId = node.data.cardId as string | undefined;
        if (cardId) {
          selectCard(cardId, node.id, false);
        } else {
          isProgrammaticSelectRef.current = false;
        }
      }
    },
    [selectCard, selectEventNode],
  );

  return {
    onSelectionChange,
    onNodeClick,
    selectGraphNodeForFollow,
    selectGraphNodeOnFirstLoad,
  };
}

/**
 * useNodesSelectedSync — dashboard-store 선택 상태를 ReactFlow 노드 `selected`에 반영
 *
 * useNodeSelection과 분리한 이유:
 *  - setNodes는 useGraphBuilder가 소유한다.
 *  - useNodeSelection이 setNodes를 받으면 호출 순서 의존(builder → selection)이 강제된다.
 *  - 이 동기화 effect만 분리하면 useNodeSelection은 builder보다 먼저 호출 가능하다.
 */
export function useNodesSelectedSync(
  setNodes: (updater: (prev: GraphNode[]) => GraphNode[]) => void,
  selectedCardId: string | null,
  selectedNodeId: string | null,
): void {
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const shouldSelect = selectedNodeId
          ? n.id === selectedNodeId
          : n.data.cardId === selectedCardId;
        return n.selected === shouldSelect ? n : { ...n, selected: shouldSelect };
      }),
    );
  }, [selectedCardId, selectedNodeId, setNodes]);
}
