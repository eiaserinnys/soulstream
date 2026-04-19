/**
 * viewport-graph-builder — Viewport API 응답을 React Flow 노드/엣지로 변환
 *
 * 서버의 viewport API가 반환하는 평탄한 이벤트 배열을 GraphNode/GraphEdge로 변환한다.
 * 기존 buildGraph(tree, dagre)와 달리, 서버가 계산한 y_start/depth를 직접 사용하므로
 * dagre 레이아웃 단계가 불필요하다.
 *
 * 각 이벤트의 위치:
 *   x = MARGIN + depth * (DEFAULT_NODE_WIDTH + TREE_H_GAP)
 *   y = MARGIN + (y_start - 1) * DEFAULT_NODE_HEIGHT
 */

import {
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  type GraphNode,
  type GraphEdge,
  type GraphNodeData,
  type GraphNodeType,
  createEdge,
} from "./layout-engine";
import { TREE_H_GAP } from "./tree-layout";

// === Viewport Event Type ===

/** 서버 viewport API가 반환하는 이벤트 항목 */
export interface ViewportEvent {
  id: number;
  parent_event_id: number | null;
  event_type: string;
  depth: number;
  y_start: number;
  y_end: number;
  payload: Record<string, unknown>;
}

// === Constants ===

const MARGIN = 20;

/**
 * 서버 event_type → SSE node-factory ID prefix 매핑.
 *
 * SSE builder(node-factory.ts)가 tree node에 부여하는 ID prefix와
 * 일치해야 viewport/live 노드 dedup이 정상 동작한다.
 *
 * 매핑이 없는 event_type은 event_type 그대로 사용한다.
 */
const EVENT_TYPE_TO_ID_PREFIX: Record<string, string> = {
  user_message: "user-msg",
  system_message: "system-msg",
  input_request: "input-request",
  assistant_message: "asst-msg",
  assistant_error: "asst-error",
  away_summary: "away-summary",
  tool_use: "tool",
};

/** event_type에 대응하는 SSE builder 호환 ID prefix를 반환한다. */
function idPrefix(eventType: string): string {
  return EVENT_TYPE_TO_ID_PREFIX[eventType] ?? eventType;
}

// === Main Build Function ===

/**
 * viewport 이벤트 배열을 React Flow 노드/엣지로 변환한다.
 *
 * @param events - 서버 viewport API 응답의 events 배열
 * @returns React Flow 노드/엣지
 */
export function buildViewportGraph(
  events: ViewportEvent[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (events.length === 0) return { nodes: [], edges: [] };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 이벤트 ID → GraphNode ID 매핑 (엣지 생성용)
  const eventIdToNodeId = new Map<number, string>();
  // 노드 ID Set — O(1) 존재 확인 (엣지 부모 후보 탐색용)
  const nodeIdSet = new Set<string>();

  for (const evt of events) {
    const node = viewportEventToNode(evt);
    if (!node) continue;

    nodes.push(node);
    eventIdToNodeId.set(evt.id, node.id);
    nodeIdSet.add(node.id);

    // 부모-자식 엣지 생성
    if (evt.parent_event_id != null) {
      const parentNodeId = eventIdToNodeId.get(evt.parent_event_id);
      if (parentNodeId) {
        // tool 노드의 부모 그래프 노드는 "-call" suffix가 붙을 수 있음
        const callId = `${parentNodeId}-call`;
        const actualParent = nodeIdSet.has(callId) ? callId : parentNodeId;

        edges.push(
          createEdge(actualParent, node.id, false, "right", "left"),
        );
      }
    }
  }

  return { nodes, edges };
}

// === Event → Node Conversion ===

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

function computePosition(evt: ViewportEvent): { x: number; y: number } {
  return {
    x: MARGIN + evt.depth * (DEFAULT_NODE_WIDTH + TREE_H_GAP),
    y: MARGIN + (evt.y_start - 1) * DEFAULT_NODE_HEIGHT,
  };
}

function viewportEventToNode(evt: ViewportEvent): GraphNode | null {
  const p = evt.payload;
  const position = computePosition(evt);

  switch (evt.event_type) {
    case "session":
      return makeNode(evt, position, {
        nodeType: "session",
        label: "Session Started",
        content: `Session ID: ${(p.agent_session_id as string) ?? ""}`,
        streaming: false,
      });

    case "user_message":
      return makeNode(evt, position, {
        nodeType: "user",
        label: `User (${(p.user as string) ?? "unknown"})`,
        content: truncate((p.content as string) ?? "", 120),
        streaming: false,
        fullContent: (p.content as string) ?? "",
      });

    case "intervention":
      return makeNode(evt, position, {
        nodeType: "intervention",
        label: `Intervention (${(p.user as string) ?? "unknown"})`,
        content: truncate((p.content as string) ?? "", 120),
        streaming: false,
        fullContent: (p.content as string) ?? "",
      });

    case "thinking":
      return makeNode(evt, position, {
        nodeType: "thinking",
        label: "Thinking",
        content: truncate((p.content as string) ?? "(streaming...)", 120),
        streaming: !(p.completed as boolean),
      });

    case "text":
      return makeNode(evt, position, {
        nodeType: "text",
        label: "Text",
        content: truncate((p.content as string) ?? "(streaming...)", 120),
        streaming: !(p.completed as boolean),
      });

    case "tool":
    case "tool_use":
      return makeToolNode(evt, position);

    case "result":
      return makeResultNode(evt, position);

    case "complete":
      return makeNode(evt, position, {
        nodeType: "system",
        label: "Complete",
        content: (p.content as string) ?? "Session completed",
        streaming: false,
      });

    case "error":
      return makeNode(evt, position, {
        nodeType: "system",
        label: "Error",
        content: (p.content as string) ?? "Unknown error",
        streaming: false,
        isError: true,
      });

    case "assistant_error":
      return makeNode(evt, position, {
        nodeType: "system",
        label: `API Error: ${(p.error_type as string) ?? ""}`,
        content: (p.model as string) ? `Model: ${p.model}` : ((p.content as string) ?? ""),
        streaming: false,
        isError: true,
      });

    case "compact":
      return makeNode(evt, position, {
        nodeType: "system",
        label: "\u26A1 Context Compaction",
        content: (p.content as string) ?? "Context compaction occurred",
        streaming: false,
      });

    case "input_request":
      return makeNode(evt, position, {
        nodeType: "input_request",
        label: "Input Request",
        content: truncate(
          ((p.questions as Array<{ question: string }>)?.[0]?.question) ?? "Input requested",
          120,
        ),
        streaming: !(p.completed as boolean),
        requestId: p.request_id as string | undefined,
        questions: p.questions as GraphNodeData["questions"],
        responded: (p.responded as boolean) ?? false,
        expired: (p.expired as boolean) ?? false,
      });

    case "assistant_message":
      return makeNode(evt, position, {
        nodeType: "system",
        label: "Assistant",
        content: truncate((p.content as string) ?? "", 120),
        streaming: false,
      });

    case "away_summary":
      return makeNode(evt, position, {
        nodeType: "system",
        label: "Away Summary",
        content: truncate((p.content as string) ?? "", 120),
        streaming: false,
      });

    // 스트리밍 델타/내부 이벤트는 건너뛴다
    case "text_delta":
    case "thinking_delta":
    case "history_sync":
    case "subtree_update":
    case "session_updated":
      return null;

    default:
      return makeNode(evt, position, {
        nodeType: "system",
        label: evt.event_type,
        content: `[${evt.event_type}]`,
        streaming: false,
      });
  }
}

function makeNode(
  evt: ViewportEvent,
  position: { x: number; y: number },
  data: Partial<GraphNodeData> & { nodeType: GraphNodeType; label: string; content: string; streaming: boolean },
): GraphNode {
  const prefix = idPrefix(evt.event_type);
  return {
    id: `node-${prefix}-${evt.id}`,
    type: data.nodeType,
    position,
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      ...data,
      cardId: data.cardId ?? `${prefix}-${evt.id}`,
    } as GraphNodeData,
  };
}

function makeToolNode(
  evt: ViewportEvent,
  position: { x: number; y: number },
): GraphNode {
  const p = evt.payload;
  const toolName = (p.name as string) ?? (p.tool_name as string) ?? "unknown";
  const toolInput = p.input as Record<string, unknown> | undefined;
  const isCompleted = (p.completed as boolean) ?? true;
  const isError = (p.is_error as boolean) ?? false;

  const toolCategory = toolName === "Skill" ? "skill" as const
    : (toolName === "Agent" || toolName === "Task") ? "sub-agent" as const
    : undefined;

  const prefix = idPrefix(evt.event_type);
  return {
    id: `node-${prefix}-${evt.id}-call`,
    type: "tool_call",
    position,
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    data: {
      nodeType: "tool_call",
      cardId: `${prefix}-${evt.id}`,
      label: toolName,
      content: formatToolInput(toolInput),
      toolName,
      toolInput,
      streaming: !isCompleted,
      isError,
      toolCategory,
    } as GraphNodeData,
  };
}

function makeResultNode(
  evt: ViewportEvent,
  position: { x: number; y: number },
): GraphNode {
  const p = evt.payload;
  const durationMs = p.duration_ms as number | undefined;
  const totalCostUsd = p.total_cost_usd as number | undefined;
  const usage = p.usage as { input_tokens: number; output_tokens: number } | undefined;

  const durationStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : "";
  const costStr = totalCostUsd ? `$${totalCostUsd.toFixed(4)}` : "";

  return makeNode(evt, position, {
    nodeType: "result",
    label: "Session Complete",
    content: [durationStr, costStr].filter(Boolean).join(" | ") || "Completed",
    streaming: false,
    durationMs,
    usage,
    totalCostUsd,
    stopReason: p.stop_reason as string | undefined,
    errors: p.errors as string[] | undefined,
    modelUsage: p.model_usage as Record<string, unknown> | undefined,
    permissionDenials: p.permission_denials as string[] | undefined,
  });
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
  if (keys.length > 3) parts.push(`+${keys.length - 3} more`);
  return parts.join("\n");
}
