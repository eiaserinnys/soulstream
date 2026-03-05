/**
 * Soul Dashboard - Layout Engine
 *
 * EventTreeNode 트리를 DFS 순회하여 React Flow 노드/엣지로 변환하는 레이아웃 엔진.
 * 원점 기반 메인 플로우 열 + 상대 오프셋(COL_STEP) 배치 + 순차 Y 누적 방식으로 레이아웃을 적용합니다.
 */

import type { Node, Edge } from "@xyflow/react";
import type { EventTreeNode } from "@shared/types";

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
  | "tool_result"   // ToolResultBlock
  | "subagent"      // Subagent (가상)
  | "result"        // ResultMessage
  | "response"      // 하위 호환
  | "system"        // 시스템 메시지
  | "error";        // 에러

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

  // subagent 전용
  agentId?: string;
  agentType?: string;

  // result 전용
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;

  // 기존 필드들
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  subAgentId?: string;  // 하위 호환
  /** 플랜 모드 관련 플래그 */
  isPlanMode?: boolean;
  isPlanModeEntry?: boolean;
  isPlanModeExit?: boolean;
  /** 전체 텍스트 (user/intervention 노드의 상세 뷰용) */
  fullContent?: string;
  /** 도구 분류 배지 (Skill, Agent 등) */
  toolCategory?: "skill" | "sub-agent";
}

export type GraphNode = Node<GraphNodeData>;
export type GraphEdge = Edge;

// === Sub-Agent Grouping ===

/** Task 도구 호출로 감지된 서브 에이전트 그룹 */
export interface SubAgentGroup {
  /** 그룹 고유 ID */
  groupId: string;
  /** Task tool_call 카드 ID */
  taskCardId: string;
  /** 그룹에 포함된 카드 ID 목록 (Task 카드 자체 포함) */
  cardIds: string[];
  /** 그룹 레이블 (Task 입력에서 추출) */
  label: string;
  /** 접힌 상태 여부 */
  collapsed: boolean;
}


// === Node Dimensions ===

/** 노드 타입별 기본 크기 (그리드 레이아웃에 사용) */
const NODE_DIMENSIONS: Record<GraphNodeType | "group", { width: number; height: number }> = {
  session: { width: 260, height: 84 },
  user: { width: 260, height: 84 },
  intervention: { width: 260, height: 84 },
  thinking: { width: 260, height: 84 },
  text: { width: 260, height: 84 },
  tool_use: { width: 260, height: 84 },
  tool_call: { width: 260, height: 84 },
  tool_result: { width: 260, height: 84 },
  subagent: { width: 260, height: 84 },
  result: { width: 260, height: 84 },
  response: { width: 260, height: 84 },
  system: { width: 260, height: 84 },
  error: { width: 260, height: 84 },
  group: { width: 320, height: 100 },
};

/**
 * 노드 타입에 대한 크기를 반환합니다.
 */
export function getNodeDimensions(
  nodeType: GraphNodeType | "group",
): { width: number; height: number } {
  return NODE_DIMENSIONS[nodeType] ?? { width: 260, height: 84 };
}

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

// === Sub-Agent Detection ===

/**
 * EventTreeNode 트리에서 Task 도구 호출을 감지하여 서브 에이전트 그룹을 추출합니다.
 * 트리를 DFS 순회하여 tool 타입 노드 중 toolName === "Task"인 노드를 기준으로 그룹핑합니다.
 */
export function detectSubAgents(tree: EventTreeNode | null): SubAgentGroup[] {
  if (!tree) return [];

  const groups: SubAgentGroup[] = [];
  let groupCounter = 0;

  function collectToolNodes(node: EventTreeNode): EventTreeNode[] {
    const tools: EventTreeNode[] = [];
    if (node.type === "tool") {
      tools.push(node);
    }
    for (const child of node.children) {
      tools.push(...collectToolNodes(child));
    }
    return tools;
  }

  const allTools = collectToolNodes(tree);

  for (let i = 0; i < allTools.length; i++) {
    const tool = allTools[i];
    if (tool.toolName !== "Task") continue;

    groupCounter += 1;
    const groupId = `subagent-${groupCounter}`;
    const groupCardIds: string[] = [tool.id];

    const taskDescription =
      (tool.toolInput?.description as string) ??
      (tool.toolInput?.prompt as string) ??
      "Sub-agent Task";
    const label =
      taskDescription.length > 50
        ? taskDescription.slice(0, 47) + "..."
        : taskDescription;

    if (!tool.completed) {
      // 아직 실행 중인 Task: 이후 모든 도구를 그룹에 포함
      for (let j = i + 1; j < allTools.length; j++) {
        groupCardIds.push(allTools[j].id);
      }
    } else {
      // 완료된 Task: 다음 Task 시작 전까지의 도구를 그룹에 포함
      for (let j = i + 1; j < allTools.length; j++) {
        if (allTools[j].toolName === "Task") break;
        groupCardIds.push(allTools[j].id);
      }
    }

    groups.push({
      groupId,
      taskCardId: tool.id,
      cardIds: groupCardIds,
      label,
      collapsed: false,
    });
  }

  return groups;
}

// === Plan Mode Detection ===

/** EnterPlanMode ~ ExitPlanMode 범위 */
export interface PlanModeRange {
  enterNodeId: string;
  exitNodeId: string;
  /** ExitPlanMode가 명시적으로 발견되었는지 여부 */
  closed: boolean;
}

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
  const allTools: EventTreeNode[] = [];
  function collectTools(node: EventTreeNode) {
    if (node.type === "tool") {
      allTools.push(node);
    }
    for (const child of node.children) {
      collectTools(child);
    }
  }
  collectTools(tree);

  let enterNode: EventTreeNode | null = null;

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
interface CollapseInfo {
  collapsed?: boolean;
  hasChildren?: boolean;
  childCount?: number;
}

function createTextNode(
  treeNode: EventTreeNode,
  planFlags?: { isPlanMode?: boolean },
  collapseInfo?: CollapseInfo,
): GraphNode {
  // text 노드는 항상 "thinking" 타입. 실제 응답은 complete 노드가 담당.
  return {
    id: `node-${treeNode.id}`,
    type: "thinking",
    position: { x: 0, y: 0 },
    data: {
      nodeType: "thinking",
      cardId: treeNode.id,
      label: "Thinking",
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

function createToolCallNode(
  treeNode: EventTreeNode,
  planFlags?: { isPlanMode?: boolean; isPlanModeEntry?: boolean; isPlanModeExit?: boolean },
  collapseInfo?: CollapseInfo,
): GraphNode {
  return {
    id: `node-${treeNode.id}-call`,
    type: "tool_call",
    position: { x: 0, y: 0 },
    data: {
      nodeType: "tool_call",
      cardId: treeNode.id,
      label: treeNode.toolName ?? "Tool",
      content: formatToolInput(treeNode.toolInput),
      toolName: treeNode.toolName,
      toolInput: treeNode.toolInput,
      streaming: !treeNode.completed && !treeNode.toolResult,
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

function createToolResultNode(treeNode: EventTreeNode): GraphNode | null {
  if (treeNode.toolResult === undefined && treeNode.completed) {
    return {
      id: `node-${treeNode.id}-result`,
      type: "tool_result",
      position: { x: 0, y: 0 },
      data: {
        nodeType: "tool_result",
        cardId: treeNode.id,
        label: `${treeNode.toolName ?? "Tool"} Result`,
        content: "(no output)",
        toolName: treeNode.toolName,
        toolResult: "",
        isError: treeNode.isError,
        streaming: false,
        durationMs: treeNode.durationMs,
      },
    };
  }

  if (treeNode.toolResult === undefined) {
    return {
      id: `node-${treeNode.id}-result`,
      type: "tool_result",
      position: { x: 0, y: 0 },
      data: {
        nodeType: "tool_result",
        cardId: treeNode.id,
        label: `${treeNode.toolName ?? "Tool"} Result`,
        content: "(waiting...)",
        toolName: treeNode.toolName,
        streaming: true,
      },
    };
  }

  return {
    id: `node-${treeNode.id}-result`,
    type: "tool_result",
    position: { x: 0, y: 0 },
    data: {
      nodeType: "tool_result",
      cardId: treeNode.id,
      label: `${treeNode.toolName ?? "Tool"} Result`,
      content: truncate(treeNode.toolResult, 120),
      toolName: treeNode.toolName,
      toolResult: treeNode.toolResult,
      isError: treeNode.isError,
      streaming: false,
      durationMs: treeNode.durationMs,
    },
  };
}

function createUserNode(treeNode: EventTreeNode): GraphNode {
  return {
    id: `node-${treeNode.id}`,
    type: "user",
    position: { x: 0, y: 0 },
    data: {
      nodeType: "user",
      label: `User (${treeNode.user ?? "unknown"})`,
      content: truncate(treeNode.content, 120),
      streaming: false,
      fullContent: treeNode.content,
    },
  };
}

function createInterventionNodeFromTree(
  treeNode: EventTreeNode,
  collapseInfo?: CollapseInfo,
): GraphNode {
  return {
    id: `node-${treeNode.id}`,
    type: "intervention",
    position: { x: 0, y: 0 },
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

function createSystemNodeFromTree(treeNode: EventTreeNode): GraphNode {
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
    label = "Session Started";
    content = `Session ID: ${treeNode.sessionId ?? treeNode.content}`;
  }

  return {
    id: `node-${treeNode.id}`,
    type: "system",
    position: { x: 0, y: 0 },
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

function createSubagentNode(
  treeNode: EventTreeNode,
  collapseInfo?: CollapseInfo,
): GraphNode {
  return {
    id: `node-${treeNode.id}`,
    type: "subagent",
    position: { x: 0, y: 0 },
    data: {
      nodeType: "subagent",
      cardId: treeNode.id,
      label: treeNode.agentType ?? "Agent",
      content: `Agent: ${treeNode.agentId ?? "unknown"}`,
      streaming: !treeNode.completed,
      agentId: treeNode.agentId,
      agentType: treeNode.agentType,
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

function createResultNode(
  treeNode: EventTreeNode,
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

// === Main Build Function ===

/**
 * EventTreeNode 트리를 React Flow 노드/엣지로 변환합니다.
 *
 * DFS 순회로 트리를 탐색하며:
 * - session root의 자식 (user_message, intervention) → Col A 메인 플로우
 * - user_message/intervention의 자식 (text, complete, error) → Col A 메인 플로우
 * - text의 자식 (tool) → Col B/C 수평 분기
 *
 * @param tree - 이벤트 트리 루트
 * @param collapsedNodeIds - 접힌 노드 ID 집합 (접힌 노드의 자식은 렌더링되지 않음)
 */
export function buildGraph(
  tree: EventTreeNode | null,
  collapsedNodeIds: Set<string> = new Set(),
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (!tree) return { nodes, edges };

  // 플랜 모드 감지
  const planMode = detectPlanModeRanges(tree);

  // 메인 플로우 추적
  let prevMainFlowNodeId: string | null = null;
  let lastThinkingNodeId: string | null = null;

  // (tool 분기와 subagent 배치는 applyDagreLayout이 엣지 그래프에서 자동 추론)

  // session root 자체는 system 노드로 표시 (sessionId가 있는 경우)
  if (tree.sessionId) {
    const sessionNode = createSystemNodeFromTree(tree);
    nodes.push(sessionNode);
    prevMainFlowNodeId = sessionNode.id;
  }

  // session root의 자식들을 순회 (user_message, intervention, result 등)
  for (const turnNode of tree.children) {
    if (turnNode.type === "user_message") {
      // user_message 노드
      if (turnNode.content) {
        const userNode = createUserNode(turnNode);
        nodes.push(userNode);
        if (prevMainFlowNodeId) {
          edges.push(createEdge(prevMainFlowNodeId, userNode.id));
        }
        prevMainFlowNodeId = userNode.id;
      }

      // user_message의 자식들을 처리
      processChildNodes(turnNode);
    } else if (turnNode.type === "intervention") {
      // intervention 노드
      const collapseInfo = getCollapseInfo(turnNode);
      const intvNode = createInterventionNodeFromTree(turnNode, collapseInfo);
      nodes.push(intvNode);
      if (prevMainFlowNodeId) {
        edges.push(createEdge(prevMainFlowNodeId, intvNode.id));
      }
      prevMainFlowNodeId = intvNode.id;

      // intervention의 자식들을 처리 (접히지 않은 경우만)
      if (!collapsedNodeIds.has(turnNode.id)) {
        processChildNodes(turnNode);
      }
    } else if (turnNode.type === "complete" || turnNode.type === "error") {
      // complete/error가 root 직하에 있는 경우
      const sysNode = createSystemNodeFromTree(turnNode);
      nodes.push(sysNode);
      if (prevMainFlowNodeId) {
        edges.push(createEdge(prevMainFlowNodeId, sysNode.id));
      }
      prevMainFlowNodeId = sysNode.id;
    } else if (turnNode.type === "result") {
      // result 노드
      const collapseInfo = getCollapseInfo(turnNode);
      const resultGraphNode = createResultNode(turnNode, collapseInfo);
      nodes.push(resultGraphNode);
      if (prevMainFlowNodeId) {
        edges.push(createEdge(prevMainFlowNodeId, resultGraphNode.id));
      }
      prevMainFlowNodeId = resultGraphNode.id;
    } else if (turnNode.type === "tool") {
      // root 직하에 tool이 있는 경우 (비정상이지만 방어적 처리)
      processToolNode(turnNode, lastThinkingNodeId ?? prevMainFlowNodeId);
    } else if (turnNode.type === "subagent") {
      // root 직하에 subagent가 있는 경우 (ID 매칭 실패 방어)
      processSubagentNode(turnNode, lastThinkingNodeId ?? prevMainFlowNodeId);
    } else if (turnNode.type === "text") {
      // root 직하에 text가 있는 경우 (비정상이지만 방어적 처리)
      processTextNode(turnNode);
    }
  }

  /** 노드의 접기/펼치기 정보를 계산합니다 */
  function getCollapseInfo(treeNode: EventTreeNode): CollapseInfo {
    const hasChildren = treeNode.children.length > 0;
    const isCollapsed = collapsedNodeIds.has(treeNode.id);
    return {
      collapsed: isCollapsed,
      hasChildren,
      childCount: countAllDescendants(treeNode),
    };
  }

  function processChildNodes(parentTurnNode: EventTreeNode) {
    // 가상 thinking 노드 필요 여부 판정
    let hasToolBeforeText = false;
    let hasText = false;
    for (const child of parentTurnNode.children) {
      if (child.type === "text") { hasText = true; break; }
      if (child.type === "tool") { hasToolBeforeText = true; }
    }

    if (hasToolBeforeText && !hasText || hasToolBeforeText) {
      // 첫 text 이전에 tool이 있으면 가상 thinking 삽입 여부 확인
      let foundText = false;
      for (const child of parentTurnNode.children) {
        if (child.type === "text") { foundText = true; break; }
      }
      if (!foundText || hasToolBeforeText) {
        // 가상 thinking이 필요한지 정확히 판단
        let needsVirtual = false;
        for (const child of parentTurnNode.children) {
          if (child.type === "text") break;
          if (child.type === "tool") { needsVirtual = true; break; }
        }
        if (needsVirtual) {
          const virtualNode: GraphNode = {
            id: `node-virtual-init-${parentTurnNode.id}`,
            type: "thinking",
            position: { x: 0, y: 0 },
            data: {
              nodeType: "thinking",
              label: "Initial Tools",
              content: "(tools invoked before first thinking)",
              streaming: false,
            },
          };
          nodes.push(virtualNode);
          if (prevMainFlowNodeId) {
            edges.push(createEdge(prevMainFlowNodeId, virtualNode.id));
          }
          prevMainFlowNodeId = virtualNode.id;
          lastThinkingNodeId = virtualNode.id;
        }
      }
    }

    for (const child of parentTurnNode.children) {
      if (child.type === "text") {
        processTextNode(child);
      } else if (child.type === "tool") {
        processToolNode(child, lastThinkingNodeId ?? prevMainFlowNodeId);
      } else if (child.type === "complete" || child.type === "error") {
        const sysNode = createSystemNodeFromTree(child);
        nodes.push(sysNode);
        if (prevMainFlowNodeId) {
          edges.push(createEdge(prevMainFlowNodeId, sysNode.id));
        }
        prevMainFlowNodeId = sysNode.id;
      }
    }
  }

  function processTextNode(textTreeNode: EventTreeNode) {
    const collapseInfo = getCollapseInfo(textTreeNode);
    const graphNode = createTextNode(textTreeNode, {
      isPlanMode: planMode.nodeIds.has(textTreeNode.id),
    }, collapseInfo);
    nodes.push(graphNode);

    if (prevMainFlowNodeId) {
      edges.push(createEdge(prevMainFlowNodeId, graphNode.id, !textTreeNode.completed));
    }
    prevMainFlowNodeId = graphNode.id;
    lastThinkingNodeId = graphNode.id;

    // 접힌 상태면 자식 처리 안함
    if (collapsedNodeIds.has(textTreeNode.id)) {
      return;
    }

    // text의 자식들을 처리 (tool, subagent, 중첩 text 등)
    for (const child of textTreeNode.children) {
      if (child.type === "tool") {
        processToolNode(child, graphNode.id);
      } else if (child.type === "subagent") {
        processSubagentNode(child, graphNode.id);
      } else if (child.type === "text") {
        // 중첩된 text (서브에이전트 내부 등)
        processTextNode(child);
      }
    }
  }

  function processToolNode(toolTreeNode: EventTreeNode, parentNodeId: string | null) {
    const collapseInfo = getCollapseInfo(toolTreeNode);
    const callNode = createToolCallNode(toolTreeNode, {
      isPlanMode: planMode.nodeIds.has(toolTreeNode.id),
      isPlanModeEntry: planMode.entryIds.has(toolTreeNode.id),
      isPlanModeExit: planMode.exitIds.has(toolTreeNode.id),
    }, collapseInfo);
    nodes.push(callNode);

    if (parentNodeId) {
      edges.push(
        createEdge(parentNodeId, callNode.id, !toolTreeNode.completed && !toolTreeNode.toolResult, "right", "left"),
      );
    }

    const resultNode = createToolResultNode(toolTreeNode);

    if (resultNode) {
      nodes.push(resultNode);
      edges.push(createEdge(callNode.id, resultNode.id, resultNode.data.streaming, "right", "left"));
    }

    // 접힌 상태면 자식 처리 안함
    if (collapsedNodeIds.has(toolTreeNode.id)) {
      return;
    }

    // tool의 자식 처리 (subagent 등)
    for (const child of toolTreeNode.children) {
      if (child.type === "subagent") {
        processSubagentNode(child, callNode.id);
      } else if (child.type === "text") {
        processTextNode(child);
      } else if (child.type === "tool") {
        processToolNode(child, callNode.id);
      }
    }
  }

  function processSubagentNode(subagentTreeNode: EventTreeNode, parentNodeId: string | null) {
    const collapseInfo = getCollapseInfo(subagentTreeNode);
    const subagentGraphNode = createSubagentNode(subagentTreeNode, collapseInfo);
    nodes.push(subagentGraphNode);

    if (parentNodeId) {
      edges.push(
        createEdge(parentNodeId, subagentGraphNode.id, !subagentTreeNode.completed),
      );
    }

    // 접힌 상태면 자식 처리 안함
    if (collapsedNodeIds.has(subagentTreeNode.id)) {
      return;
    }

    // subagent의 자식들 처리 (text, tool 등)
    for (const child of subagentTreeNode.children) {
      if (child.type === "text") {
        const childCollapseInfo = getCollapseInfo(child);
        const childGraphNode = createTextNode(child, {
          isPlanMode: planMode.nodeIds.has(child.id),
        }, childCollapseInfo);
        nodes.push(childGraphNode);
        edges.push(createEdge(subagentGraphNode.id, childGraphNode.id, !child.completed));

        if (!collapsedNodeIds.has(child.id)) {
          for (const grandchild of child.children) {
            if (grandchild.type === "tool") {
              processToolNode(grandchild, childGraphNode.id);
            }
          }
        }
      } else if (child.type === "tool") {
        processToolNode(child, subagentGraphNode.id);
      }
    }
  }

  return applyDagreLayout(nodes, edges);
}

// === Grid Layout ===

/** tool 체인이 부모 노드 우측에 배치될 때의 수평 간격 */
const TOOL_BRANCH_H_GAP = 120;
const V_GAP = 16;

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

  const NODE_WIDTH = getNodeDimensions("thinking").width;
  const MARGIN = 20;
  const COL_STEP = NODE_WIDTH + TOOL_BRANCH_H_GAP;
  const FLOW_GAP = 60; // depth 0 (메인 플로우) 수직 간격

  // 노드 맵
  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) nodeMap.set(node.id, node);

  // 엣지에서 부모→자식 인접 리스트 구성
  type ChildRef = { id: string; horizontal: boolean };
  const childrenOf = new Map<string, ChildRef[]>();
  const incoming = new Set<string>();

  for (const edge of edges) {
    const h = edge.sourceHandle === "right" && edge.targetHandle === "left";
    if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, []);
    childrenOf.get(edge.source)!.push({ id: edge.target, horizontal: h });
    incoming.add(edge.target);
  }

  // 루트 = incoming 엣지 없는 최상위 노드
  const roots = nodes.filter((n) => !incoming.has(n.id) && !n.parentId);

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
    const fallback = 84;
    rowHeightOf.set(id, fallback);
    effHeightOf.set(id, fallback);

    const node = nodeMap.get(id);
    const selfH = node
      ? (node.type === "group"
          ? getNodeDimensions("group").height
          : getNodeDimensions(node.data.nodeType).height)
      : 84;

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

  function placeSubtree(id: string, x: number, y: number) {
    if (positions.has(id)) return; // 사이클 방어
    positions.set(id, { x, y });

    const ch = childrenOf.get(id) ?? [];
    const hCh = ch.filter((c) => c.horizontal);
    const vCh = ch.filter((c) => !c.horizontal);

    // 수평 자식: 오른쪽으로, V_GAP 간격으로 아래로 스택
    let hy = y;
    for (const hc of hCh) {
      placeSubtree(hc.id, x + COL_STEP, hy);
      hy += computeHeights(hc.id).eff + V_GAP;
    }

    // 수직 자식: 아래로, 같은 X
    const row = rowHeightOf.get(id) ?? 84;
    const vGap = (depthOf.get(id) ?? 0) === 0 ? FLOW_GAP : V_GAP;
    let vy = y + row + vGap;
    for (const vc of vCh) {
      placeSubtree(vc.id, x, vy);
      vy += computeHeights(vc.id).eff + vGap;
    }
  }

  // 루트부터 배치
  let rootY = MARGIN;
  for (const r of roots) {
    computeHeights(r.id);
    placeSubtree(r.id, MARGIN, rootY);
    rootY += (effHeightOf.get(r.id) ?? 84) + FLOW_GAP;
  }

  // 위치 반영
  const positioned = nodes.map((node) => {
    if (node.parentId) {
      // 그룹 자식: 부모 내부 상대 배치
      const sibs = nodes.filter((n) => n.parentId === node.parentId);
      const idx = sibs.findIndex((n) => n.id === node.id);
      const d = getNodeDimensions(node.data.nodeType);
      return { ...node, position: { x: 20, y: 40 + idx * (d.height + 16) } };
    }
    const p = positions.get(node.id);
    return p ? { ...node, position: p } : node;
  });

  return { nodes: positioned, edges };
}
