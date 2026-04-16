/**
 * Soul Dashboard - Node Builders
 *
 * EventTreeNode 트리 노드를 React Flow GraphNode로 변환하는 팩토리 함수 모음.
 * layout-engine.ts에서 분리된 모듈로, 노드 생성 책임만 담당합니다.
 * 위치 배정(layout)은 tree-layout.ts에서 담당합니다.
 */

import type {
  EventTreeNode,
  ToolNode,
  UserMessageNode,
  InterventionNode,
  SessionNode,
  ResultNode,
  CompleteNode,
  ErrorNode,
  AssistantErrorNode,
  CompactNode,
  InputRequestNodeDef,
} from "../shared/types";
import {
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  type GraphNode,
  type GraphNodeType,
} from "./layout-engine";

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
      expired: treeNode.expired,
      collapsed: collapseInfo?.collapsed ?? false,
      hasChildren: collapseInfo?.hasChildren ?? false,
      childCount: collapseInfo?.childCount ?? 0,
    },
  };
}

export function createSystemNodeFromTree(treeNode: SessionNode | CompleteNode | ErrorNode | AssistantErrorNode): GraphNode {
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
  } else if (treeNode.type === "assistant_error") {
    const errNode = treeNode as AssistantErrorNode;
    label = `API Error: ${errNode.errorType}`;
    content = errNode.model ? `Model: ${errNode.model}` : errNode.content;
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
      stopReason: treeNode.stopReason,
      errors: treeNode.errors,
      modelUsage: treeNode.modelUsage,
      permissionDenials: treeNode.permissionDenials,
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
