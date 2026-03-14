/**
 * Soul Dashboard - Layout Engine
 *
 * EventTreeNode 트리를 DFS 순회하여 React Flow 노드/엣지로 변환하는 레이아웃 엔진.
 * 원점 기반 메인 플로우 열 + 상대 오프셋(COL_STEP) 배치 + 순차 Y 누적 방식으로 레이아웃을 적용합니다.
 */

import type { Node, Edge } from "@xyflow/react";
import type {
  EventTreeNode,
  ToolNode,
  UserMessageNode,
  InterventionNode,
  SessionNode,
  ResultNode,
  CompleteNode,
  ErrorNode,
  CompactNode,
  InputRequestNodeDef,
  InputRequestQuestion,
} from "@shared/types";
import { createLayoutContext } from "./layout-context";
import { processChildNodes } from "./renderers";

// === Graph Node Types ===

/** 노드 그래프에 표시되는 커스텀 노드 타입 */
export type GraphNodeType =
  | "session"       // 가상 루트 (숨김)
  | "user"          // UserMessage
  | "intervention"  // Intervention
  | "thinking"      // ThinkingBlock
  | "text"          // TextBlock (하위 호환)
  | "tool_use"      // ToolUseBlock
  | "tool_call"     // 하위 호환 alias
  | "result"        // ResultMessage
  | "response"      // 하위 호환
  | "system"        // 시스템 메시지
  | "error"         // 에러
  | "input_request"; // AskUserQuestion

/** React Flow 노드의 data 필드 */
export interface GraphNodeData extends Record<string, unknown> {
  nodeType: GraphNodeType;
  cardId?: string;
  label: string;
  content: string;
  streaming: boolean;

  // 접기/펼치기 (모든 노드에 적용)
  collapsed?: boolean;        // 현재 접힌 상태
  hasChildren?: boolean;      // 자식 노드 존재 여부
  childCount?: number;        // 자식 노드 수 (전체 자손)

  // result 전용
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;

  // 기존 필드들
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  /** 플랜 모드 관련 플래그 */
  isPlanMode?: boolean;
  isPlanModeEntry?: boolean;
  isPlanModeExit?: boolean;
  /** 전체 텍스트 (user/intervention 노드의 상세 뷰용) */
  fullContent?: string;
  /** 도구 분류 배지 (Skill, Agent 등) */
  toolCategory?: "skill" | "sub-agent";

  // input_request 전용
  requestId?: string;
  questions?: InputRequestQuestion[];
  responded?: boolean;
}

export type GraphNode = Node<GraphNodeData>;
export type GraphEdge = Edge;

// === Node Dimensions ===

/** 모든 카드의 기본 크기 (노드 생성 시 사용) */
export const DEFAULT_NODE_WIDTH = 260;
export const DEFAULT_NODE_HEIGHT = 84;

// === Edge Creation ===

/**
 * React Flow 엣지를 생성합니다.
 *
 * 결정론적 ID를 사용합니다 (source, target, handle 조합으로 유일성 보장).
 */
export function createEdge(
  source: string,
  target: string,
  animated = false,
  sourceHandle?: string,
  targetHandle?: string,
): GraphEdge {
  const handleSuffix = sourceHandle || targetHandle
    ? `-${sourceHandle ?? "d"}-${targetHandle ?? "d"}`
    : "";
  return {
    id: `e-${source}-${target}${handleSuffix}`,
    source,
    target,
    animated,
    sourceHandle,
    targetHandle,
    style: { stroke: animated ? "#3b82f6" : "#4b5563", strokeWidth: 1.5 },
  };
}

// === Plan Mode Detection ===

/**
 * EventTreeNode 트리에서 EnterPlanMode / ExitPlanMode 도구 호출을 감지하여
 * 플랜 모드 구간을 반환합니다.
 */
export function detectPlanModeRanges(tree: EventTreeNode | null): { nodeIds: Set<string>; entryIds: Set<string>; exitIds: Set<string> } {
  const nodeIds = new Set<string>();
  const entryIds = new Set<string>();
  const exitIds = new Set<string>();

  if (!tree) return { nodeIds, entryIds, exitIds };

  // 트리의 모든 tool 노드를 DFS 순서로 수집
  const allTools: ToolNode[] = [];
  function collectTools(node: EventTreeNode) {
    if (node.type === "tool") {
      allTools.push(node);
    }
    for (const child of node.children) {
      collectTools(child);
    }
  }
  collectTools(tree);

  let enterNode: ToolNode | null = null;

  for (const tool of allTools) {
    if (tool.toolName === "EnterPlanMode") {
      enterNode = tool;
      entryIds.add(tool.id);
      nodeIds.add(tool.id);
    } else if (tool.toolName === "ExitPlanMode" && enterNode) {
      exitIds.add(tool.id);
      nodeIds.add(tool.id);
      enterNode = null;
    } else if (enterNode) {
      nodeIds.add(tool.id);
    }
  }

  return { nodeIds, entryIds, exitIds };
}

// === Node Creation Helpers ===

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

/** 추가 접기/펼치기 정보 */
export interface CollapseInfo {
  collapsed?: boolean;
  hasChildren?: boolean;
  childCount?: number;
}

export function createTextNode(
  treeNode: EventTreeNode,
  planFlags?: { isPlanMode?: boolean },
  collapseInfo?: CollapseInfo,
): GraphNode {
  // thinking 노드와 text 노드를 독립 타입으로 구분
  const isThinking = treeNode.type === "thinking";
  const nodeType: GraphNodeType = isThinking ? "thinking" : "text";
  const label = isThinking ? "Thinking" : "Text";

  return {
    id: `node-${treeNode.id}`,
    type: nodeType,
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType,
      cardId: treeNode.id,
      label,
      content: truncate(treeNode.content, 120) || "(streaming...)",
      streaming: !treeNode.completed,
      isPlanMode: planFlags?.isPlanMode,
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

/** 도구 이름으로 카테고리를 판정합니다. */
function getToolCategory(toolName?: string): "skill" | "sub-agent" | undefined {
  if (!toolName) return undefined;
  if (toolName === "Skill") return "skill";
  if (toolName === "Agent" || toolName === "Task") return "sub-agent";
  return undefined;
}

export function createToolCallNode(
  treeNode: ToolNode,
  planFlags?: { isPlanMode?: boolean; isPlanModeEntry?: boolean; isPlanModeExit?: boolean },
  collapseInfo?: CollapseInfo,
): GraphNode {
  return {
    id: `node-${treeNode.id}-call`,
    type: "tool_call",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "tool_call",
      cardId: treeNode.id,
      label: treeNode.toolName,
      content: formatToolInput(treeNode.toolInput),
      toolName: treeNode.toolName,
      toolInput: treeNode.toolInput,
      streaming: !treeNode.completed && !treeNode.toolResult,
      isError: treeNode.isError,
      isPlanMode: planFlags?.isPlanMode,
      isPlanModeEntry: planFlags?.isPlanModeEntry,
      isPlanModeExit: planFlags?.isPlanModeExit,
      toolCategory: getToolCategory(treeNode.toolName),
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

export function createUserNode(treeNode: UserMessageNode): GraphNode {
  return {
    id: `node-${treeNode.id}`,
    type: "user",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "user",
      label: `User (${treeNode.user})`,
      content: truncate(treeNode.content, 120),
      streaming: false,
      fullContent: treeNode.content,
    },
  };
}

export function createInterventionNodeFromTree(
  treeNode: InterventionNode,
  collapseInfo?: CollapseInfo,
): GraphNode {
  return {
    id: `node-${treeNode.id}`,
    type: "intervention",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "intervention",
      cardId: treeNode.id,
      label: `Intervention (${treeNode.user ?? "unknown"})`,
      content: truncate(treeNode.content, 120),
      streaming: false,
      fullContent: treeNode.content,
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

export function createInputRequestNodeFromTree(
  treeNode: InputRequestNodeDef,
  collapseInfo?: CollapseInfo,
): GraphNode {
  const firstQuestion = treeNode.questions[0]?.question ?? "Input requested";
  return {
    id: `node-${treeNode.id}`,
    type: "input_request",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "input_request",
      cardId: treeNode.id,
      label: "Input Request",
      content: truncate(firstQuestion, 120),
      streaming: !treeNode.completed,
      requestId: treeNode.requestId,
      questions: treeNode.questions,
      responded: treeNode.responded,
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

export function createSystemNodeFromTree(treeNode: SessionNode | CompleteNode | ErrorNode): GraphNode {
  let label: string;
  let content: string;

  if (treeNode.type === "complete") {
    label = "Complete";
    content = treeNode.content
      ? truncate(treeNode.content, 100)
      : "Session completed";
  } else if (treeNode.type === "error") {
    label = "Error";
    content = treeNode.content;
  } else {
    const sn = treeNode as SessionNode;
    if (sn.sessionType === "llm") {
      const parts = ["LLM Session"];
      if (sn.llmProvider) parts.push(sn.llmProvider);
      if (sn.llmModel) parts.push(sn.llmModel);
      label = parts.join(" \u00B7 ");
      content = "";
    } else {
      label = "Session Started";
      content = `Session ID: ${treeNode.sessionId ?? treeNode.content}`;
    }
  }

  return {
    id: `node-${treeNode.id}`,
    type: "system",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "system",
      label,
      content,
      isError: treeNode.type === "error",
      streaming: false,
      fullContent: treeNode.content,
    },
  };
}

export function createCompactNode(treeNode: CompactNode): GraphNode {
  return {
    id: `node-${treeNode.id}`,
    type: "system",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "system",
      label: "\u26A1 Context Compaction",
      content: treeNode.content || "Context compaction occurred",
      streaming: false,
    },
  };
}

export function createResultNode(
  treeNode: ResultNode,
  collapseInfo?: CollapseInfo,
): GraphNode {
  const durationStr = treeNode.durationMs
    ? `${(treeNode.durationMs / 1000).toFixed(1)}s`
    : "";
  const costStr = treeNode.totalCostUsd
    ? `$${treeNode.totalCostUsd.toFixed(4)}`
    : "";

  return {
    id: `node-${treeNode.id}`,
    type: "system",
    position: { x: 0, y: 0 },
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "result",
      cardId: treeNode.id,
      label: "Session Complete",
      content: [durationStr, costStr].filter(Boolean).join(" | ") || "Completed",
      streaming: false,
      fullContent: treeNode.content,
      durationMs: treeNode.durationMs,
      usage: treeNode.usage,
      totalCostUsd: treeNode.totalCostUsd,
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

// === Utility ===

/**
 * 노드의 모든 자손 수를 재귀적으로 카운트합니다.
 */
export function countAllDescendants(node: EventTreeNode): number {
  let count = node.children.length;
  for (const child of node.children) {
    count += countAllDescendants(child);
  }
  return count;
}

function formatToolInput(input?: Record<string, unknown>): string {
  if (!input) return "(no input)";

  const keys = Object.keys(input);
  if (keys.length === 0) return "(no input)";

  const parts: string[] = [];
  for (const key of keys.slice(0, 3)) {
    const val = input[key];
    const str = typeof val === "string" ? val : JSON.stringify(val);
    const truncated = str && str.length > 50 ? str.slice(0, 47) + "..." : str;
    parts.push(`${key}: ${truncated}`);
  }

  if (keys.length > 3) {
    parts.push(`+${keys.length - 3} more`);
  }

  return parts.join("\n");
}

// === Collapse Info Helper ===

/**
 * 노드의 접기/펼치기 정보를 계산합니다.
 * 렌더러 함수에서 사용합니다.
 */
export function getCollapseInfo(treeNode: EventTreeNode, collapsedNodeIds: Set<string>): CollapseInfo {
  const hasChildren = treeNode.children.length > 0;
  const isCollapsed = collapsedNodeIds.has(treeNode.id);
  return {
    collapsed: isCollapsed,
    hasChildren,
    childCount: countAllDescendants(treeNode),
  };
}

// === Main Build Function ===

/**
 * EventTreeNode 트리를 React Flow 노드/엣지로 변환합니다.
 *
 * DFS 순회로 트리를 탐색하며:
 * - session root의 자식 (user_message, intervention) → Col A 메인 플로우
 * - user_message/intervention의 자식 (text, complete, error) → Col A 메인 플로우
 * - text의 자식 (tool) → Col B/C 수평 분기
 *
 * LayoutContext에 공유 상태를 캡슐화하고, 렌더러 registry를 통해
 * 노드 타입별 렌더링을 위임합니다.
 *
 * @param tree - 이벤트 트리 루트
 * @param collapsedNodeIds - 접힌 노드 ID 집합 (접힌 노드의 자식은 렌더링되지 않음)
 */
export function buildGraph(
  tree: EventTreeNode | null,
  collapsedNodeIds: Set<string> = new Set(),
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!tree) return { nodes: [], edges: [] };

  // LayoutContext 생성
  const planMode = detectPlanModeRanges(tree);
  const ctx = createLayoutContext(planMode, collapsedNodeIds);

  // session root는 항상 가상 노드로 생성
  const sessionNode = createSystemNodeFromTree(tree as SessionNode);
  ctx.nodes.push(sessionNode);

  // session root의 자식(턴 노드)들을 processChildNodes로 처리.
  // 형제 체인(u1→u2→u3)이 생성되며, sibling 엣지는 data.sibling=true로 마킹되어
  // placeSubtree에서 들여쓰기 없이 같은 x 좌표에 배치된다.
  processChildNodes(tree, sessionNode.id, ctx);

  return applyDagreLayout(ctx.nodes, ctx.edges);
}

// === Grid Layout ===

/** tool 체인이 부모 노드 우측에 배치될 때의 수평 간격 */
const TOOL_BRANCH_H_GAP = 120;
const V_GAP = 16;
/** 트리 계층 들여쓰기 폭 */
const INDENT_STEP = 40;

/**
 * 엣지 기반 재귀 레이아웃을 적용합니다.
 *
 * 모든 노드를 동일한 로직으로 배치합니다:
 * - 엣지 핸들로 방향 결정: right→left = 수평 자식, 그 외 = 수직 자식
 * - 수평 자식: parent.x + COL_STEP, 부모 Y에서 아래로 V_GAP 간격 스택
 * - 수직 자식: parent.x, parent.y + rowHeight + gap
 * - effectiveHeight: 재귀적으로 모든 자손의 높이를 포함
 */
export function applyDagreLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const MARGIN = 20;
  const FLOW_GAP = 60; // depth 0 (메인 플로우) 수직 간격

  // 노드 맵
  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) nodeMap.set(node.id, node);

  // 엣지에서 부모→자식 인접 리스트 구성
  type ChildRef = { id: string; horizontal: boolean; sibling: boolean };
  const childrenOf = new Map<string, ChildRef[]>();
  const incoming = new Set<string>();

  for (const edge of edges) {
    const h = edge.sourceHandle === "right" && edge.targetHandle === "left";
    const s = !!(edge.data as Record<string, unknown> | undefined)?.sibling;
    if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, []);
    childrenOf.get(edge.source)!.push({ id: edge.target, horizontal: h, sibling: s });
    incoming.add(edge.target);
  }

  // 루트 = incoming 엣지 없는 최상위 노드
  const roots = nodes.filter((n) => !incoming.has(n.id));

  // depth 계산: 수평 엣지 +1, 수직 엣지 동일 (사이클 방어 포함)
  const depthOf = new Map<string, number>();
  function assignDepth(id: string, d: number) {
    if (depthOf.has(id)) return;
    depthOf.set(id, d);
    for (const c of childrenOf.get(id) ?? []) {
      assignDepth(c.id, c.horizontal ? d + 1 : d);
    }
  }
  for (const r of roots) assignDepth(r.id, 0);

  // 높이 계산 (bottom-up, memoized)
  const rowHeightOf = new Map<string, number>();
  const effHeightOf = new Map<string, number>();

  function computeHeights(id: string): { row: number; eff: number } {
    if (effHeightOf.has(id)) {
      return { row: rowHeightOf.get(id)!, eff: effHeightOf.get(id)! };
    }

    // 사이클 방어: 계산 진입 즉시 기본값으로 마킹
    const fallback = DEFAULT_NODE_HEIGHT;
    rowHeightOf.set(id, fallback);
    effHeightOf.set(id, fallback);

    const node = nodeMap.get(id);
    const selfH = node?.height ?? fallback;

    const ch = childrenOf.get(id) ?? [];
    const hCh = ch.filter((c) => c.horizontal);
    const vCh = ch.filter((c) => !c.horizontal);

    // rowHeight = max(자신, 수평 자식 스택 높이)
    let hStack = 0;
    for (let i = 0; i < hCh.length; i++) {
      if (i > 0) hStack += V_GAP;
      hStack += computeHeights(hCh[i].id).eff;
    }
    const row = Math.max(selfH, hStack);

    // effectiveHeight = rowHeight + 수직 자식 전체
    const vGap = (depthOf.get(id) ?? 0) === 0 ? FLOW_GAP : V_GAP;
    let eff = row;
    for (const vc of vCh) {
      eff += vGap + computeHeights(vc.id).eff;
    }

    rowHeightOf.set(id, row);
    effHeightOf.set(id, eff);
    return { row, eff };
  }

  // 위치 배정 (top-down)
  const positions = new Map<string, { x: number; y: number }>();

  function placeSubtree(id: string, x: number, y: number, isRootLevel: boolean = false) {
    if (positions.has(id)) return; // 사이클 방어
    positions.set(id, { x, y });

    const ch = childrenOf.get(id) ?? [];
    const hCh = ch.filter((c) => c.horizontal);
    const vCh = ch.filter((c) => !c.horizontal);

    // 수평 자식: 부모 width + H_GAP만큼 오른쪽으로, V_GAP 간격으로 아래로 스택
    const parentW = nodeMap.get(id)?.width ?? DEFAULT_NODE_WIDTH;
    const colStep = parentW + TOOL_BRANCH_H_GAP;
    let hy = y;
    for (const hc of hCh) {
      placeSubtree(hc.id, x + colStep, hy, false);
      hy += computeHeights(hc.id).eff + V_GAP;
    }

    // 수직 자식: sibling 엣지는 같은 x (형제 체인), 그 외는 들여쓰기
    const row = rowHeightOf.get(id) ?? DEFAULT_NODE_HEIGHT;
    const vGap = (depthOf.get(id) ?? 0) === 0 ? FLOW_GAP : V_GAP;
    let vy = y + row + vGap;
    for (const vc of vCh) {
      // sibling 엣지: 형제이므로 같은 x 유지
      // isRootLevel: 세션 루트에서 첫째 자식도 같은 x 유지
      const childX = (vc.sibling || isRootLevel) ? x : x + INDENT_STEP;
      placeSubtree(vc.id, childX, vy, false);
      vy += computeHeights(vc.id).eff + vGap;
    }
  }

  // 루트부터 배치
  let rootY = MARGIN;
  for (const r of roots) {
    computeHeights(r.id);
    placeSubtree(r.id, MARGIN, rootY, true);
    rootY += (effHeightOf.get(r.id) ?? 84) + FLOW_GAP;
  }

  // 위치 반영
  const positioned = nodes.map((node) => {
    const p = positions.get(node.id);
    return p ? { ...node, position: p } : node;
  });

  return { nodes: positioned, edges };
}
