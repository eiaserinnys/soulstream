/**
 * NodeGraph - React Flow 기반 노드 그래프 패널
 *
 * Soul 실행 이벤트를 노드 기반 그래프로 시각화합니다.
 * thinking-tool 관계를 React Flow로 표현하며
 * 스트리밍 실시간 업데이트를 지원합니다.
 *
 * 데이터 소스:
 *  - **viewport API** (주): 뷰포트 범위의 이벤트만 서버에서 로드 (useViewportNodes)
 *  - **SSE 라이브** (보조): store.tree의 실시간 이벤트를 증분 반영 (useGraphBuilder)
 *
 * 컴포넌트는 렌더링과 훅 조합만 담당하며, 실제 동작은 5개 커스텀 훅에 위임합니다:
 *  - useViewportNodes   : viewport API → 로컬 GraphNode/GraphEdge
 *  - useGraphBuilder    : 트리 → 그래프 변환 + 디바운싱 + 증분 업데이트 (라이브 이벤트)
 *  - useAutoScroll      : 새 노드 pan, fitView, autoScroll 토글
 *  - useNodeSelection   : ReactFlow 선택 ↔ dashboard-store 동기화 + 키보드 네비
 *  - useGraphDump       : 그래프 덤프 생성/다운로드 + Ctrl+Shift+D
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  ReactFlowProvider,
  PanOnScrollMode,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  useDashboardStore,
  countTreeNodes,
  countStreamingNodes,
} from "../stores/dashboard-store";
import { AskQuestionBanner } from "./AskQuestionBanner";
import { cn } from "../lib/cn";
import { useTheme } from "../hooks/useTheme";
import { nodeTypes } from "./nodes";
import { DEFAULT_NODE_HEIGHT, type GraphNode } from "../lib/layout-engine";
import { FIXED_ZOOM, MIN_ZOOM, useAutoScroll } from "../hooks/useAutoScroll";
import { useGraphBuilder } from "../hooks/useGraphBuilder";
import { useNodeSelection } from "../hooks/useNodeSelection";
import { useGraphDump } from "../hooks/useGraphDump";
import { useViewportFetch } from "../hooks/useViewportFetch";
import { useViewportNodes } from "../hooks/useViewportNodes";

// === Inner Graph (needs ReactFlow context) ===

function NodeGraphInner() {
  const [theme] = useTheme();
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const treeChangeInfo = useDashboardStore((s) => s.treeChangeInfo);
  const selectedCardId = useDashboardStore((s) => s.selectedCardId);
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const collapsedNodeIds = useDashboardStore((s) => s.collapsedNodeIds);
  const lastEventId = useDashboardStore((s) => s.lastEventId);
  const processingCtx = useDashboardStore((s) => s.processingCtx);

  // 1. 자동 스크롤 + lastNode/뷰포트 조작
  const {
    autoScroll,
    onMoveEnd,
    handleToggleAutoScroll,
    setLastNode,
    panToNode,
    panOnFirstLoad,
  } = useAutoScroll(activeSessionKey);

  // 1-1. Viewport API — 뷰포트 범위의 이벤트를 서버에서 로드
  const viewport = useViewportNodes(activeSessionKey);

  const reactFlow = useReactFlow();
  const rfStore = useStoreApi();

  // ReactFlow 뷰포트 → {yStart, yEnd} (subtree_height 단위)
  const computeViewportRange = useCallback(() => {
    const { height: vpH } = rfStore.getState();
    if (!vpH || vpH === 0) return null;
    const vp = reactFlow.getViewport();
    if (!vp.zoom) return null;
    const worldYTop = -vp.y / vp.zoom;
    const worldYBottom = (vpH - vp.y) / vp.zoom;
    return {
      yStart: worldYTop / DEFAULT_NODE_HEIGHT,
      yEnd: worldYBottom / DEFAULT_NODE_HEIGHT,
    };
  }, [reactFlow, rfStore]);

  // pan/zoom 시 viewport refetch 트로틀러
  const { request: requestViewport } = useViewportFetch(
    (range: { yStart: number; yEnd: number }) => {
      viewport.fetchViewport(range);
    },
  );

  // onMoveEnd 래퍼: 기존 훅 호출 + 뷰포트 fetch 트리거
  // - 사용자 조작(event != null)일 때만 fetch (프로그래매틱 이동은 스킵)
  const wrappedOnMoveEnd: typeof onMoveEnd = useCallback(
    (event, _viewport) => {
      onMoveEnd(event, _viewport);
      if (event === null) return;
      const range = computeViewportRange();
      if (range) requestViewport(range);
    },
    [onMoveEnd, computeViewportRange, requestViewport],
  );

  // 2. ReactFlow 선택 ↔ store 동기화 + 프로그래밍 select 헬퍼
  const selection = useNodeSelection();

  // 3. 빌더가 호출할 콜백 묶음 (selection + autoScroll 결합)
  const handleFollowSelect = useCallback(
    (node: GraphNode) => selection.selectGraphNodeForFollow(node),
    [selection],
  );

  const handleFirstLoad = useCallback(
    (node: GraphNode) => {
      selection.selectGraphNodeOnFirstLoad(node);
      panOnFirstLoad(node);
    },
    [selection, panOnFirstLoad],
  );

  const handleIncrementalAdded = useCallback(
    (node: GraphNode) => {
      // autoScroll ON 시: 새 노드를 자동 선택하고 pan
      if (!autoScroll) return;
      selection.selectGraphNodeForFollow(node);
      requestAnimationFrame(() => {
        panToNode(node);
      });
    },
    [autoScroll, selection, panToNode],
  );

  const getAutoScroll = useCallback(() => autoScroll, [autoScroll]);

  // 4. 트리 → 그래프 변환 (라이브 SSE 이벤트용 — 증분 업데이트)
  const builder = useGraphBuilder({
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
    onIncrementalNodeAdded: handleIncrementalAdded,
    onFirstLoadAdded: handleFirstLoad,
    onFollowSelect: handleFollowSelect,
    onFollowPan: panToNode,
  });

  // 5. viewport + live 노드 병합 + selection 동기화
  // viewport API 노드가 주 데이터소스, 라이브 SSE 노드를 dedup 후 병합.
  // selection을 병합 단계에서 적용하여 모든 소스의 노드에 반영한다.
  const mergedNodes = useMemo(() => {
    let combined: GraphNode[];
    if (viewport.nodes.length === 0) {
      combined = builder.nodes;
    } else if (builder.nodes.length === 0) {
      combined = viewport.nodes;
    } else {
      const vpNodeIds = new Set(viewport.nodes.map((n) => n.id));
      const liveOnly = builder.nodes.filter((n) => !vpNodeIds.has(n.id));
      combined = [...viewport.nodes, ...liveOnly];
    }

    // selection 동기화 — useNodesSelectedSync 대체
    return combined.map((n) => {
      const shouldSelect = selectedNodeId
        ? n.id === selectedNodeId
        : n.data.cardId === selectedCardId;
      return n.selected === shouldSelect ? n : { ...n, selected: shouldSelect };
    });
  }, [viewport.nodes, builder.nodes, selectedCardId, selectedNodeId]);

  const mergedEdges = useMemo(() => {
    if (viewport.edges.length === 0) return builder.edges;
    if (builder.edges.length === 0) return viewport.edges;

    const vpEdgeIds = new Set(viewport.edges.map((e) => e.id));
    const liveOnly = builder.edges.filter((e) => !vpEdgeIds.has(e.id));
    return [...viewport.edges, ...liveOnly];
  }, [viewport.edges, builder.edges]);

  // 7. 그래프 덤프 다운로드 (Ctrl+Shift+D + Dump 버튼)
  const { dumpGraph } = useGraphDump({
    activeSessionKey,
    treeVersion,
    lastEventId,
    tree,
    nodes: mergedNodes,
    edges: mergedEdges,
    processingCtx,
  });

  // 빈 상태
  if (!activeSessionKey) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-sm">Select a session</div>
      </div>
    );
  }

  if (viewport.isLoading && viewport.nodes.length === 0 && !tree) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-sm">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-success animate-[pulse_2s_infinite] mr-2 align-middle" />
          Loading graph...
        </div>
      </div>
    );
  }

  if (mergedNodes.length === 0 && !tree) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-sm">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-success animate-[pulse_2s_infinite] mr-2 align-middle" />
          Waiting for events...
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={mergedNodes}
        edges={mergedEdges}
        onNodesChange={builder.onNodesChange}
        onEdgesChange={builder.onEdgesChange}
        onSelectionChange={selection.onSelectionChange}
        onNodeClick={selection.onNodeClick}
        onMoveEnd={wrappedOnMoveEnd}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        defaultViewport={{ x: 0, y: 0, zoom: FIXED_ZOOM }}
        minZoom={MIN_ZOOM}
        maxZoom={2}
        // DOM 가상화 — 대규모 세션에서도 뷰포트 노드만 렌더링.
        onlyRenderVisibleElements={true}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnScroll={true}
        panOnScrollMode={PanOnScrollMode.Vertical}
        zoomActivationKeyCode="Control"
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5, opacity: 0.3 },
        }}
        style={{ width: "100%", height: "100%" }}
      >
        <Background
          color="var(--muted-foreground)"
          gap={20}
          size={1}
          style={{ opacity: 0.15 }}
        />
        <Controls
          showInteractive={false}
          style={{
            borderRadius: 6,
            border: "1px solid var(--border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        />
        {/* Auto-scroll 토글 + Dump */}
        <GraphControlsPanel
          autoScroll={autoScroll}
          onToggleAutoScroll={handleToggleAutoScroll}
          onDump={dumpGraph}
        />
      </ReactFlow>
      {/* AskUserQuestion 배너: 캔버스 하단 중앙 오버레이 */}
      <AskQuestionBanner />
    </div>
  );
}

// === NodeGraph (with ReactFlowProvider wrapper) ===

export function NodeGraph() {
  return (
    <div data-testid="node-graph" className="flex flex-col h-full overflow-hidden">
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

// === Bottom-right Controls Panel (Dump + Follow toggle) ===

function GraphControlsPanel({
  autoScroll,
  onToggleAutoScroll,
  onDump,
}: {
  autoScroll: boolean;
  onToggleAutoScroll: () => void;
  onDump: () => void;
}) {
  return (
    <Panel position="bottom-right">
      <div className="flex items-center gap-1.5">
        <button
          onClick={onDump}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors border shadow-md bg-popover border-border text-muted-foreground hover:bg-input"
          title="Dump graph state (Ctrl+Shift+D)"
        >
          Dump
        </button>
        <button
          onClick={onToggleAutoScroll}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
            "border shadow-md",
            autoScroll
              ? "bg-accent-blue/15 border-accent-blue/30 text-accent-blue hover:bg-accent-blue/25"
              : "bg-popover border-border text-muted-foreground hover:bg-input",
          )}
          title={
            autoScroll
              ? "Auto-scroll ON — click to disable"
              : "Auto-scroll OFF — click to follow latest node"
          }
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
      </div>
    </Panel>
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
    <div className="py-3 px-3.5 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wide flex justify-between items-center">
      <span>Execution Flow</span>
      <div className="flex items-center gap-2">
        {streamingCount > 0 && (
          <span className="flex items-center gap-1 text-success font-normal text-xs normal-case">
            <span className="w-[5px] h-[5px] rounded-full bg-success animate-[pulse_2s_infinite]" />
            {streamingCount} active
          </span>
        )}
        <span className="text-muted-foreground font-normal">{nodeCount}</span>
      </div>
    </div>
  );
}
