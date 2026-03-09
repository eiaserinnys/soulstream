/**
 * flatten-tree - 이벤트 트리를 flat한 채팅 메시지 리스트로 변환
 *
 * DFS 순회하여 각 트리 노드를 ChatMessage로 매핑합니다.
 * session 루트 노드는 skip하고, 서브에이전트 children도 구분 없이 flat하게 포함합니다.
 */

import type {
  EventTreeNode,
  SessionNode,
  ThinkingNode,
  TextNode,
  ToolNode,
  ResultNode,
  UserMessageNode,
  InterventionNode,
} from "@shared/types";

/** Chat 탭에 표시되는 메시지 단위 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "intervention";
  /** 메인 표시 텍스트 */
  content: string;
  timestamp?: number;
  /** thinking 전용: 접기 토글에 표시할 내면 사고 텍스트 */
  thinkingContent?: string;
  /** tool 전용 */
  toolName?: string;
  toolDurationMs?: number;
  isError?: boolean;
  /** text/thinking 전용: 스트리밍 중 여부 */
  isStreaming?: boolean;
  /** result 전용 */
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
  durationMs?: number;
  /** 원본 트리 노드 ID (클릭 시 Detail 연동용) */
  treeNodeId: string;
  treeNodeType: string;
}

/**
 * 이벤트 트리를 flat한 ChatMessage 리스트로 변환합니다.
 *
 * - session 루트 노드는 skip (children만 순회)
 * - 각 노드 타입별 ChatMessage 변환
 * - children 재귀 (서브에이전트 포함, 구분 없이 flat)
 */
export function flattenTree(root: EventTreeNode | null): ChatMessage[] {
  if (!root) return [];

  const messages: ChatMessage[] = [];
  collectMessages(root, messages);
  return messages;
}

function collectMessages(
  node: EventTreeNode,
  out: ChatMessage[],
): void {
  // session 루트: pid가 있으면 시스템 메시지로 표시
  if (node.type === "session") {
    const sessionNode = node as SessionNode;
    if (sessionNode.pid != null) {
      out.push({
        id: `${node.id}-pid`,
        role: "system",
        content: `Process ID: ${sessionNode.pid}`,
        treeNodeId: node.id,
        treeNodeType: "session",
      });
    }
  } else {
    const msg = nodeToMessage(node);
    if (msg) out.push(msg);
  }

  for (const child of node.children) {
    collectMessages(child, out);
  }
}

function nodeToMessage(node: EventTreeNode): ChatMessage | null {
  switch (node.type) {
    case "user_message": {
      const n = node as UserMessageNode;
      return {
        id: n.id,
        role: "user",
        content: n.content,
        timestamp: n.timestamp,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "intervention": {
      const n = node as InterventionNode;
      return {
        id: n.id,
        role: "intervention",
        content: n.content,
        timestamp: n.timestamp,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "thinking": {
      const n = node as ThinkingNode;
      return {
        id: n.id,
        role: "assistant",
        content: n.textContent ?? n.content,
        thinkingContent: n.content,
        timestamp: n.timestamp,
        isStreaming: !n.textCompleted && n.textContent !== undefined,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "text": {
      const n = node as TextNode;
      return {
        id: n.id,
        role: "assistant",
        content: n.content,
        timestamp: n.timestamp,
        isStreaming: !n.textCompleted,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "tool":
    case "tool_use": {
      const n = node as ToolNode;
      const status = n.completed
        ? n.isError
          ? "error"
          : "done"
        : "running";
      const durationStr = n.durationMs
        ? `${(n.durationMs / 1000).toFixed(1)}s`
        : "";
      const content = durationStr
        ? `${n.toolName}  ${status}  ${durationStr}`
        : `${n.toolName}  ${status}`;

      return {
        id: n.id,
        role: "tool",
        content,
        timestamp: n.timestamp,
        toolName: n.toolName,
        toolDurationMs: n.durationMs,
        isError: n.isError,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "result": {
      const n = node as ResultNode;
      const parts: string[] = ["Session Complete"];
      if (n.durationMs) parts.push(`${(n.durationMs / 1000).toFixed(1)}s`);
      if (n.totalCostUsd) parts.push(`$${n.totalCostUsd.toFixed(4)}`);

      return {
        id: n.id,
        role: "system",
        content: parts.join("  "),
        timestamp: n.timestamp,
        usage: n.usage,
        totalCostUsd: n.totalCostUsd,
        durationMs: n.durationMs,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "error": {
      return {
        id: node.id,
        role: "system",
        content: node.content,
        timestamp: node.timestamp,
        isError: true,
        treeNodeId: node.id,
        treeNodeType: node.type,
      };
    }

    case "compact": {
      return {
        id: node.id,
        role: "system",
        content: node.content,
        timestamp: node.timestamp,
        treeNodeId: node.id,
        treeNodeType: node.type,
      };
    }

    case "complete": {
      return {
        id: node.id,
        role: "system",
        content: node.content || "Turn completed",
        timestamp: node.timestamp,
        treeNodeId: node.id,
        treeNodeType: node.type,
      };
    }

    default:
      return null;
  }
}
