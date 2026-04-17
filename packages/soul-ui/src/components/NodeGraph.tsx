/**
 * NodeGraph - React Flow 기반 노드 그래프 패널
 *
 * Soul 실행 이벤트를 노드 기반 그래프로 시각화합니다.
 * thinking-tool 관계를 React Flow로 표현하며
 * 스트리밍 실시간 업데이트를 지원합니다.
 *
 * 컴포넌트는 렌더링과 훅 조합만 담당하며, 실제 동작은 4개 커스텀 훅에 위임합니다:
 *  - useGraphBuilder    : 트리 → 그래프 변환 + 디바운싱 + 증분 업데이트
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
import {
  useNodeSelection,
  useNodesSelectedSync,
} from "../hooks/useNodeSelection";
import { useGraphDump } from "../hooks/useGraphDump";
import { useViewportFetch } from "../hooks/useViewportFetch";

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
  const setTotalSubtreeHeight = useDashboardStore(
    (s) => s.setTotalSubtreeHeight,
  );

  // 1. 자동 스크롤 + lastNode/뷰포트 조작
  const {
    autoScroll,
    onMoveEnd,
    handleToggleAutoScroll,
    setLastNode,
    panToNode,
    panOnFirstLoad,
  } = useAutoScroll(activeSessionKey);

  // 1-1. 뷰포트 API fetch (Phase 3)
  // - 서버가 알려주는 total_subtree_height를 store에 정본으로 반영
  // - ReactFlow의 onlyRenderVisibleElements=true가 DOM 가상화를 담당하고,
  //   이 fetch는 뷰포트 API 엔드포인트 동작을 검증하며 서버 드리프트를 교정한다.
  // - 기존 store.tree (SSE 히스토리) 파이프라인은 그대로 소스 오브 트루스로 유지.
  const reactFlow = useReactFlow();
  const rfStore = useStoreApi();
  const viewportFetcher = useCallback(
    async (range: { yStart: number; yEnd: number }) => {
      if (!activeSessionKey) return;
      const qs = new URLSearchParams({
        y_min: String(Math.max(1, Math.floor(range.yStart))),
        y_max: String(Math.max(1, Math.ceil(range.yEnd))),
      });
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(activeSessionKey)}/events/viewport?${qs}`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { total_subtree_height?: number };
        if (typeof data.total_subtree_height === "number") {
          setTotalSubtreeHeight(data.total_subtree_height);
        }
      } catch {
        // 네트워크 오류는 무시 — 라이브 SSE 파이프라인이 소스 오브 트루스이므로
        // 뷰포트 fetch 실패가 UI를 망가뜨리지 않는다.
      }
    },
    [activeSessionKey, setTotalSubtreeHeight],
  );

  const { request: requestViewport } = useViewportFetch(viewportFetcher);

  // ReactFlow 뷰포트 → {yStart, yEnd} (subtree_height 단위)
  const computeViewportRange = useCallback(() => {
    const { height: vpH } = rfStore.getState();
    if (!vpH || vpH === 0) return null;
    const viewport = reactFlow.getViewport();
    if (!viewport.zoom) return null;
    const worldYTop = -viewport.y / viewport.zoom;
    const worldYBottom = (vpH - viewport.y) / viewport.zoom;
    return {
      yStart: worldYTop / DEFAULT_NODE_HEIGHT,
      yEnd: worldYBottom / DEFAULT_NODE_HEIGHT,
    };
  }, [reactFlow, rfStore]);

  // 세션 전환 시 초기 fetch (뷰포트 크기가 아직 0일 수 있으므로 기본 범위로 대체)
  useEffect(() => {
    if (!activeSessionKey) return;
    const range = computeViewportRange() ?? { yStart: 1, yEnd: 50 };
    requestViewport(range);
  }, [activeSessionKey, computeViewportRange, requestViewport]);

  // onMoveEnd 래퍼: 기존 훅 호출 + 뷰포트 fetch 트리거
  // - 사용자 조작(event != null)일 때만 fetch (프로그래매틱 이동은 스킵)
  const wrappedOnMoveEnd = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      onMoveEnd(event);
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

  // 4. 트리 → 그래프 변환 (디바운싱 + 증분 업데이트)
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

  // 5. store 선택 → ReactFlow 노드 selected 동기화
  useNodesSelectedSync(builder.setNodes, selectedCardId, selectedNodeId);

  // 6. 그래프 덤프 다운로드 (Ctrl+Shift+D + Dump 버튼)
  const { dumpGraph } = useGraphDump({
    activeSessionKey,
    treeVersion,
    lastEventId,
    tree,
    nodes: builder.nodes,
    edges: builder.edges,
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

  if (!tree) {
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
        nodes={builder.nodes}
        edges={builder.edges}
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
        // Phase 3: DOM 가상화 — 745노드 세션에서도 뷰포트에 있는 노드만 렌더링.
        // ReactFlow가 내부적으로 node.position + width/height + viewport로 가시성 판정.
        // translateExtent는 설정하지 않아 기존 pan UX(무제한 탐색)를 보존한다.
        onlyRenderVisibleElements={true}
        // Phase 1: UX 개선 - 줌/스크롤 동작 변경
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
