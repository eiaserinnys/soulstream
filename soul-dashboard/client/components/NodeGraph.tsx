/**
 * NodeGraph - React Flow 기반 노드 그래프 패널
 *
 * Soul 실행 이벤트를 노드 기반 그래프로 시각화합니다.
 * thinking-tool-result 관계를 React Flow로 표현하며
 * 스트리밍 실시간 업데이트와 서브에이전트 중첩 구조를 지원합니다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useStoreApi,
  ReactFlowProvider,
  PanOnScrollMode,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useDashboardStore, countTreeNodes, countStreamingNodes } from "../stores/dashboard-store";
import { nodeTypes } from "../nodes";
import {
  buildGraph,
  getNodeDimensions,
  type GraphNode,
  type GraphEdge,
} from "../lib/layout-engine";
import { cn } from "../lib/cn";

/** 그래프 재구성 디바운스 간격 (ms) - 고빈도 text_delta 이벤트 대응 */
const REBUILD_DEBOUNCE_MS = 100;

/** 고정 줌 비율 (Complete 상태 기준) */
const FIXED_ZOOM = 0.9;

/** 최소 줌 비율 (ReactFlow minZoom과 동기화) */
const MIN_ZOOM = 0.1;

/** 뷰포트 가장자리와 새 노드 사이의 최소 마진 (px) */
const PAN_MARGIN = 80;

/**
 * 특정 노드가 뷰포트에 보이도록 하기 위해 필요한 pan(dx, dy)을 계산합니다.
 * 줌은 절대 변경하지 않습니다. 이미 보이면 { dx: 0, dy: 0 }을 반환합니다.
 */
function calcPanToNode(
  node: GraphNode,
  viewport: { x: number; y: number; zoom: number },
  vpW: number,
  vpH: number,
): { dx: number; dy: number } {
  const dims = getNodeDimensions(node.data.nodeType);
  const { zoom } = viewport;
  const screenX = node.position.x * zoom + viewport.x;
  const screenY = node.position.y * zoom + viewport.y;
  const nodeW = dims.width * zoom;
  const nodeH = dims.height * zoom;

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

// === Inner Graph (needs ReactFlow context) ===

function NodeGraphInner() {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const selectedCardId = useDashboardStore((s) => s.selectedCardId);
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const selectCard = useDashboardStore((s) => s.selectCard);
  const selectEventNode = useDashboardStore((s) => s.selectEventNode);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);

  const { getViewport, setViewport } = useReactFlow();
  const store = useStoreApi();

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);

  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedRef = useRef(false);
  const prevSessionKeyRef = useRef<string | null>(null);
  const selectedCardIdRef = useRef(selectedCardId);
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedCardIdRef.current = selectedCardId;
  selectedNodeIdRef.current = selectedNodeId;

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

  // 트리/이벤트가 변경되면 그래프 재구성 (디바운스 적용)
  useEffect(() => {
    if (!activeSessionKey) {
      setNodes([]);
      setEdges([]);
      prevNodeIdsRef.current = new Set();
      hasInitializedRef.current = false;
      prevSessionKeyRef.current = null;
      return;
    }

    if (prevSessionKeyRef.current !== null && prevSessionKeyRef.current !== activeSessionKey) {
      prevNodeIdsRef.current = new Set();
      hasInitializedRef.current = false;
    }
    prevSessionKeyRef.current = activeSessionKey;

    let rafId: number | undefined;

    const timer = setTimeout(() => {
      const { nodes: newNodes, edges: newEdges } = buildGraph(tree);

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
        lastNodeRef.current = nodesWithSelection[nodesWithSelection.length - 1];
      }

      if (addedNodes.length > 0) {
        const isFirstLoad = !hasInitializedRef.current;

        // Follow 모드 ON일 때 마지막 추가 노드를 자동 선택
        if (!isFirstLoad && autoScroll) {
          const lastAdded = addedNodes[addedNodes.length - 1];
          const cardId = lastAdded.data.cardId as string | undefined;
          const nodeType = lastAdded.data.nodeType as string | undefined;

          if (cardId) {
            selectCard(cardId, lastAdded.id);
          } else if (nodeType === "user" || nodeType === "intervention" || nodeType === "system") {
            selectEventNode({
              nodeType,
              label: (lastAdded.data.label as string) ?? "",
              content: (lastAdded.data.fullContent as string) ?? (lastAdded.data.content as string) ?? "",
            });
          }
        }

        rafId = requestAnimationFrame(() => {
          const { width: vpW, height: vpH } = store.getState();
          if (vpW === 0 || vpH === 0) return;

          if (isFirstLoad) {
            hasInitializedRef.current = true;

            // 초기 로드: 줌은 FIXED_ZOOM 고정, 마지막 노드가 보이도록 pan
            const targetNode = nodesWithSelection[nodesWithSelection.length - 1];
            const viewport = { x: 0, y: 0, zoom: FIXED_ZOOM };
            const { dx, dy } = calcPanToNode(targetNode, viewport, vpW, vpH);

            isProgrammaticMoveRef.current = true;
            setViewport(
              { x: viewport.x + dx, y: viewport.y + dy, zoom: FIXED_ZOOM },
              { duration: 300 },
            );
            return;
          }

          // 스트리밍 중 auto-scroll이 OFF면 pan 하지 않음
          if (!autoScroll) return;

          hasInitializedRef.current = true;

          const viewport = getViewport();
          const targetNode = addedNodes[addedNodes.length - 1];
          const { dx, dy } = calcPanToNode(targetNode, viewport, vpW, vpH);

          if (dx === 0 && dy === 0) return;

          isProgrammaticMoveRef.current = true;
          setViewport(
            { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom },
            { duration: 300 },
          );
        });
      }
    }, REBUILD_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [
    treeVersion,
    tree,
    activeSessionKey,
    autoScroll,
    setNodes,
    setEdges,
    getViewport,
    setViewport,
    store,
    selectCard,
    selectEventNode,
  ]);

  // 선택 상태 변경 시 노드의 selected 속성만 업데이트
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

  // 노드 선택 → 카드 선택 또는 이벤트 노드 선택 동기화
  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      if (selectedNodes.length === 1) {
        const nodeData = selectedNodes[0].data;
        const nodeType = nodeData?.nodeType as string | undefined;

        const cardId = nodeData?.cardId as string | undefined;
        if (cardId) {
          selectCard(cardId, selectedNodes[0].id);
          return;
        }

        if (nodeType === "user" || nodeType === "intervention" || nodeType === "system") {
          selectEventNode({
            nodeType,
            label: (nodeData?.label as string) ?? "",
            content: (nodeData?.fullContent as string) ?? (nodeData?.content as string) ?? "",
          });
          return;
        }
      }
      selectCard(null);
    },
    [selectCard, selectEventNode],
  );

  // 빈 상태
  if (!activeSessionKey) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-[13px]">Select a session</div>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-[13px]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-success animate-[pulse_2s_infinite] mr-2 align-middle" />
          Waiting for events...
        </div>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onSelectionChange={onSelectionChange}
      onMoveEnd={onMoveEnd}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      defaultViewport={{ x: 0, y: 0, zoom: FIXED_ZOOM }}
      minZoom={MIN_ZOOM}
      maxZoom={2}
      // Phase 1: UX 개선 - 줌/스크롤 동작 변경
      zoomOnDoubleClick={false}
      zoomOnScroll={false}
      panOnScroll={true}
      panOnScrollMode={PanOnScrollMode.Vertical}
      zoomActivationKeyCode="Control"
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
      defaultEdgeOptions={{
        type: "smoothstep",
        style: { stroke: "#4b5563", strokeWidth: 1.5 },
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <Background color="#1f2937" gap={20} size={1} />
      <Controls
        showInteractive={false}
        style={{
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }}
      />
      {/* Auto-scroll 토글 */}
      <Panel position="bottom-right">
        <button
          onClick={handleToggleAutoScroll}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors",
            "border shadow-md",
            autoScroll
              ? "bg-accent-blue/15 border-accent-blue/30 text-accent-blue hover:bg-accent-blue/25"
              : "bg-popover border-border text-muted-foreground hover:bg-input",
          )}
          title={autoScroll ? "Auto-scroll ON — click to disable" : "Auto-scroll OFF — click to follow latest node"}
        >
          <span className="text-xs">{autoScroll ? "\u{2193}" : "\u{21E3}"}</span>
          {autoScroll ? "Follow" : "Follow"}
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              autoScroll ? "bg-accent-blue" : "bg-muted-foreground/40",
            )}
          />
        </button>
      </Panel>
    </ReactFlow>
  );
}

// === NodeGraph (with ReactFlowProvider wrapper) ===

export function NodeGraph() {
  return (
    <div
      data-testid="node-graph"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Header */}
      <GraphHeader />

      {/* React Flow Canvas */}
      <div className="flex-1 overflow-hidden">
        <ReactFlowProvider>
          <NodeGraphInner />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

// === Header Component ===

function GraphHeader() {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);

  const nodeCount = useMemo(() => countTreeNodes(tree), [tree, treeVersion]);
  const streamingCount = useMemo(
    () => countStreamingNodes(tree),
    [tree, treeVersion],
  );

  return (
    <div className="py-3 px-3.5 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em] flex justify-between items-center">
      <span>Execution Flow</span>
      <div className="flex items-center gap-2">
        {streamingCount > 0 && (
          <span className="flex items-center gap-1 text-success font-normal text-[11px] normal-case">
            <span className="w-[5px] h-[5px] rounded-full bg-success animate-[pulse_2s_infinite]" />
            {streamingCount} active
          </span>
        )}
        <span className="text-muted-foreground font-normal">
          {nodeCount}
        </span>
      </div>
    </div>
  );
}
