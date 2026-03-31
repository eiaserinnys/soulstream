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
  SystemMessageNode,
  InterventionNode,
  AssistantMessageNode,
  InputRequestNodeDef,
  InputRequestQuestion,
  ContextItem,
} from "@shared/types";

/** Chat 탭에 표시되는 메시지 단위 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "system_message" | "intervention" | "input_request";
  /** 메인 표시 텍스트 */
  content: string;
  timestamp?: number;
  /** thinking 전용: 접기 토글에 표시할 내면 사고 텍스트 */
  thinkingContent?: string;
  /** tool 전용 */
  toolName?: string;
  toolDurationMs?: number;
  isError?: boolean;
  /** tool 전용: 도구 입력 파라미터 */
  toolInput?: Record<string, unknown>;
  /** tool 전용: 도구 실행 결과 */
  toolResult?: string;
  /** text/thinking 전용: 스트리밍 중 여부 */
  isStreaming?: boolean;
  /** result 전용 */
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
  durationMs?: number;
  /** 원본 트리 노드 ID (클릭 시 Detail 연동용) */
  treeNodeId: string;
  treeNodeType: string;
  /** assistant_message 전용: LLM 모델명 */
  model?: string;
  /** assistant_message 전용: LLM 프로바이더 */
  provider?: string;
  /** 콘텐츠가 truncate 되었는지 여부 (큰 toolResult/thinking) */
  isTruncated?: boolean;
  /** truncate된 경우, 전체 내용을 가진 원본 이벤트 ID */
  fullContentEventId?: number;
  /** input_request 전용: 질문 목록 */
  questions?: InputRequestQuestion[];
  /** input_request 전용: 요청 ID */
  requestId?: string;
  /** input_request 전용: 응답 완료 여부 */
  responded?: boolean;
  /** input_request 전용: 만료 여부 */
  expired?: boolean;
  /** input_request 전용: 클라이언트 수신 시각 (Date.now()) */
  receivedAt?: number;
  /** input_request 전용: 응답 대기 타임아웃 (초) */
  timeoutSec?: number;
  /** user_message 전용: 구조화된 맥락 항목 배열 */
  contextItems?: ContextItem[];
  /** user_message 전용: 에이전트 발신자 메타데이터 */
  agentInfo?: {
    source: "agent";
    agent_node: string;
    agent_id: string | null;
    agent_name: string | null;
  };
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

  // result 노드가 complete 보다 먼저 오는 경우를 보정:
  // complete → result 순서가 되도록 children을 정렬 (해당 노드가 있을 때만)
  const children = node.children;
  const needsSort = children.some((c) => c.type === "result") &&
    children.some((c) => c.type === "complete");
  const ordered = needsSort
    ? [...children].sort((a, b) => {
        if (a.type === "result" && b.type === "complete") return 1;
        if (a.type === "complete" && b.type === "result") return -1;
        return 0;
      })
    : children;

  for (const child of ordered) {
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
        contextItems: n.context,
        agentInfo: n.agentInfo,
      };
    }

    case "system_message": {
      const n = node as SystemMessageNode;
      return {
        id: n.id,
        role: "system_message",
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
        content: n.content,
        thinkingContent: n.content,
        timestamp: n.timestamp,
        treeNodeId: n.id,
        treeNodeType: n.type,
        isTruncated: n.isTruncated,
        fullContentEventId: n.fullContentEventId,
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
      const durationStr = n.durationMs
        ? `(${(n.durationMs / 1000).toFixed(1)}s)`
        : "";
      const status = n.completed
        ? n.isError
          ? "error"
          : ""
        : "running";
      const content = [n.toolName, status, durationStr].filter(Boolean).join("  ");

      return {
        id: n.id,
        role: "tool",
        content,
        timestamp: n.timestamp,
        toolName: n.toolName,
        toolDurationMs: n.durationMs,
        isError: n.isError,
        toolInput: n.toolInput,
        toolResult: n.toolResult,
        treeNodeId: n.id,
        treeNodeType: n.type,
        isTruncated: n.isTruncated,
        fullContentEventId: n.fullContentEventId,
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

    case "assistant_message": {
      const n = node as AssistantMessageNode;
      return {
        id: n.id,
        role: "assistant",
        content: n.content,
        timestamp: n.timestamp,
        usage: n.usage,
        model: n.model,
        provider: n.provider,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    case "input_request": {
      const n = node as InputRequestNodeDef;
      const firstQuestion = n.questions[0]?.question ?? "Input requested";
      return {
        id: n.id,
        role: "input_request",
        content: firstQuestion,
        timestamp: n.timestamp,
        questions: n.questions,
        requestId: n.requestId,
        responded: n.responded,
        expired: n.expired,
        receivedAt: n.receivedAt,
        timeoutSec: n.timeoutSec,
        treeNodeId: n.id,
        treeNodeType: n.type,
      };
    }

    default:
      return null;
  }
}
