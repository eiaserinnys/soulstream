/**
 * useGraphBuilder — 트리 → React Flow 노드/엣지 변환 + 디바운싱 + 증분 업데이트
 *
 * 책임:
 *  - ReactFlow nodes/edges 상태 보유 (useNodesState/useEdgesState)
 *  - tree/treeChangeInfo 변경 시 증분 업데이트(node-added, node-updated) 또는 전체 재빌드
 *  - 전체 재빌드는 REBUILD_DEBOUNCE_MS만큼 디바운스 후 RAF 내부에서 pan/선택 적용
 *  - 세션 전환 시 그래프 초기화
 *  - hasInitializedRef는 RAF 내부에서 viewport 폭/높이가 확보된 시점에만 true로 전이 (원본 동일)
 *
 * pan/select 결정은 콜백으로 외부(autoScroll, selection)에 위임한다.
 */

import { useCallback, useEffect, useRef } from "react";
import { useEdgesState, useNodesState, useStoreApi } from "@xyflow/react";

import {
  buildGraph,
  buildSingleNode,
  type GraphEdge,
  type GraphNode,
} from "../lib/layout-engine";
import type { ProcessingContext, TreeChangeInfo } from "../stores/processing-context";
import type { EventTreeNode } from "@shared/types";

/** 그래프 재구성 디바운스 간격 (ms) - 고빈도 text_delta 이벤트 대응 */
export const REBUILD_DEBOUNCE_MS = 100;

export interface UseGraphBuilderParams {
  tree: EventTreeNode | null;
  treeVersion: number;
  treeChangeInfo: TreeChangeInfo | null | undefined;
  activeSessionKey: string | null;
  collapsedNodeIds: Set<string>;
  processingCtx: ProcessingContext;
  selectedCardId: string | null;
  selectedNodeId: string | null;

  /** 현재 autoScroll 플래그를 동기적으로 조회 (RAF 내부에서 호출) */
  getAutoScroll: () => boolean;

  /** lastNode 참조 갱신 — autoScroll 토글 ON 시 즉시 pan용 */
  setLastNode: (node: GraphNode | null) => void;

  /** 증분(incremental) 노드가 추가된 직후 호출 */
  onIncrementalNodeAdded: (node: GraphNode) => void;

  /** 최초 로드 시: 자동 선택 + (0,0,FIXED_ZOOM) 기준 pan */
  onFirstLoadAdded: (lastNode: GraphNode) => void;

  /** Follow 모드(autoScroll ON, !firstLoad)에서 마지막 추가 노드 자동 선택 */
  onFollowSelect: (lastAddedNode: GraphNode) => void;

  /** Follow 모드 pan — 현재 뷰포트 기준 dx/dy 계산 후 이동 */
  onFollowPan: (lastAddedNode: GraphNode) => void;
}

export interface UseGraphBuilderResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  setNodes: ReturnType<typeof useNodesState<GraphNode>>[1];
  setEdges: ReturnType<typeof useEdgesState<GraphEdge>>[1];
  onNodesChange: ReturnType<typeof useNodesState<GraphNode>>[2];
  onEdgesChange: ReturnType<typeof useEdgesState<GraphEdge>>[2];
}

export function useGraphBuilder({
  tree,
  treeVersion,
  treeChangeInfo,
  activeSessionKey,
  collapsedNodeIds,
  processingCtx,
  selectedCardId,
  selectedNodeId,
  getAutoScroll,
  setLastNode,
  onIncrementalNodeAdded,
  onFirstLoadAdded,
  onFollowSelect,
  onFollowPan,
}: UseGraphBuilderParams): UseGraphBuilderResult {
  const store = useStoreApi();

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);

  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedRef = useRef(false);
  const prevSessionKeyRef = useRef<string | null>(null);

  // 선택 상태는 ref로 보관해 effect 의존성 최소화
  const selectedCardIdRef = useRef(selectedCardId);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedCardIdRef.current = selectedCardId;
  selectedNodeIdRef.current = selectedNodeId;

  // 콜백을 ref로 보관 — 콜백 정체성 변화로 effect가 재실행되지 않게 함
  const getAutoScrollRef = useRef(getAutoScroll);
  const setLastNodeRef = useRef(setLastNode);
  const onIncrementalNodeAddedRef = useRef(onIncrementalNodeAdded);
  const onFirstLoadAddedRef = useRef(onFirstLoadAdded);
  const onFollowSelectRef = useRef(onFollowSelect);
  const onFollowPanRef = useRef(onFollowPan);
  getAutoScrollRef.current = getAutoScroll;
  setLastNodeRef.current = setLastNode;
  onIncrementalNodeAddedRef.current = onIncrementalNodeAdded;
  onFirstLoadAddedRef.current = onFirstLoadAdded;
  onFollowSelectRef.current = onFollowSelect;
  onFollowPanRef.current = onFollowPan;

  // 증분 업데이트: 텍스트/상태 변경 — 해당 노드의 data만 패치 (레이아웃 불변)
  const handleNodeUpdated = useCallback(
    (nodeId: string) => {
      const treeNode = processingCtx.nodeMap.get(nodeId);
      if (!treeNode) return;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === `node-${nodeId}` || n.id === `node-${nodeId}-call`
            ? {
                ...n,
                data: {
                  ...n.data,
                  label: treeNode.content ? n.data.label : n.data.label,
                  content: treeNode.content?.slice(0, 120) || n.data.content,
                  streaming: !treeNode.completed,
                },
              }
            : n,
        ),
      );
    },
    [processingCtx, setNodes],
  );

  // 증분 업데이트: 노드 추가 — 새 노드만 생성, 기존 노드 위치 불변
  const handleNodeAdded = useCallback(
    (nodeId: string) => {
      const treeNode = processingCtx.nodeMap.get(nodeId);
      if (!treeNode) return;

      const parent = treeNode.parent;
      if (!parent) return;

      // tool 노드의 부모는 "node-xxx-call" 형식일 수 있음
      const candidateIds = [`node-${parent.id}-call`, `node-${parent.id}`];
      const currentNodes = store.getState().nodes as GraphNode[];
      const currentEdges = store.getState().edges as GraphEdge[];
      let parentGraphNodeId: string | null = null;
      for (const cid of candidateIds) {
        if (currentNodes.some((n) => n.id === cid)) {
          parentGraphNodeId = cid;
          break;
        }
      }

      const result = buildSingleNode(
        treeNode,
        parentGraphNodeId,
        currentNodes,
        currentEdges,
        collapsedNodeIds,
      );
      if (!result.newNode) return;

      setNodes((prev) => [...prev, result.newNode!]);
      if (result.newEdge) setEdges((prev) => [...prev, result.newEdge!]);

      prevNodeIdsRef.current.add(result.newNode.id);
      setLastNodeRef.current(result.newNode);
      onIncrementalNodeAddedRef.current(result.newNode);
    },
    [processingCtx, collapsedNodeIds, store, setNodes, setEdges],
  );

  // 트리/이벤트가 변경되면 그래프 재구성 (전체 재빌드 또는 증분 업데이트)
  useEffect(() => {
    if (!activeSessionKey) {
      setNodes([]);
      setEdges([]);
      prevNodeIdsRef.current = new Set();
      hasInitializedRef.current = false;
      prevSessionKeyRef.current = null;
      return;
    }

    if (
      prevSessionKeyRef.current !== null &&
      prevSessionKeyRef.current !== activeSessionKey
    ) {
      prevNodeIdsRef.current = new Set();
      hasInitializedRef.current = false;
    }
    prevSessionKeyRef.current = activeSessionKey;

    // 증분 업데이트 경로: treeChangeInfo가 있고, 세션이 동일하며, 초기화 완료 상태
    if (treeChangeInfo && hasInitializedRef.current) {
      if (treeChangeInfo.type === "node-updated" && treeChangeInfo.nodeId) {
        handleNodeUpdated(treeChangeInfo.nodeId);
        return;
      }
      if (treeChangeInfo.type === "node-added" && treeChangeInfo.nodeId) {
        handleNodeAdded(treeChangeInfo.nodeId);
        return;
      }
      // collapse-toggle, full-rebuild → 아래 전체 재빌드로 fall through
    }

    // 전체 재빌드 경로
    let rafId: number | undefined;

    const timer = setTimeout(() => {
      const { nodes: newNodes, edges: newEdges } = buildGraph(
        tree,
        collapsedNodeIds,
      );

      const curSelectedNodeId = selectedNodeIdRef.current;
      const curSelectedCardId = selectedCardIdRef.current;
      const nodesWithSelection = newNodes.map((n) => ({
        ...n,
        selected: curSelectedNodeId
          ? n.id === curSelectedNodeId
          : n.data.cardId === curSelectedCardId,
      }));

      setNodes(nodesWithSelection);
      setEdges(newEdges);

      const currentIds = new Set(nodesWithSelection.map((n) => n.id));
      const addedNodes = nodesWithSelection.filter(
        (n) => !prevNodeIdsRef.current.has(n.id),
      );
      prevNodeIdsRef.current = currentIds;

      // 마지막 노드 참조 갱신
      if (nodesWithSelection.length > 0) {
        setLastNodeRef.current(
          nodesWithSelection[nodesWithSelection.length - 1],
        );
      }

      if (addedNodes.length > 0) {
        const isFirstLoad = !hasInitializedRef.current;

        // Follow 모드 ON일 때 마지막 추가 노드를 자동 선택 (RAF 밖, 원본 동일)
        if (!isFirstLoad && getAutoScrollRef.current()) {
          onFollowSelectRef.current(addedNodes[addedNodes.length - 1]);
        }

        rafId = requestAnimationFrame(() => {
          const { width: vpW, height: vpH } = store.getState();
          if (vpW === 0 || vpH === 0) return;

          if (isFirstLoad) {
            hasInitializedRef.current = true;
            const lastNode = nodesWithSelection[nodesWithSelection.length - 1];
            if (lastNode) {
              onFirstLoadAddedRef.current(lastNode);
            }
            return;
          }

          if (!getAutoScrollRef.current()) return;

          hasInitializedRef.current = true;
          onFollowPanRef.current(addedNodes[addedNodes.length - 1]);
        });
      }
    }, REBUILD_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [
    treeVersion,
    treeChangeInfo,
    tree,
    activeSessionKey,
    collapsedNodeIds,
    setNodes,
    setEdges,
    store,
    handleNodeUpdated,
    handleNodeAdded,
  ]);

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
  };
}
