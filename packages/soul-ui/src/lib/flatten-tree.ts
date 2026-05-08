/**
 * flatten-tree - 이벤트 트리를 flat한 채팅 메시지 리스트로 변환
 *
 * DFS 순회하여 각 트리 노드를 ChatMessage로 매핑합니다.
 * session 루트 노드는 skip하고, 서브에이전트 children도 구분 없이 flat하게 포함합니다.
 */

import type {
  CallerInfo,
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
  role: "user" | "assistant" | "tool" | "system" | "system_message" | "intervention" | "input_request" | "away_summary";
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
  /** user_message 전용: 에이전트 발신자 메타데이터 (caller_info.source==="agent"에서 도출) */
  agentInfo?: {
    source: "agent";
    agent_node: string;
    agent_id: string | null;
    agent_name: string | null;
  };
  /**
   * user_message 전용: 메시지 단위 발신자 신원 (atom ed3a216d).
   * UserMessage가 메시지 단위 caller_info.avatar_url/display_name을 우선 사용하여
   * 멀티-소스 세션에서 메시지마다 발신자 표시. 세션-수준 metadata propagation에 의존하지 않는다.
   */
  callerInfo?: CallerInfo;
  /** DB 이벤트 ID. 히스토리-라이브 병합 시 dedup 기준. */
  eventId?: number;
}

/**
 * Identity 보존 캐시 — treeNodeId → 직전 호출에서 만든 ChatMessage.
 *
 * tree-placer는 children push만 하고 노드 reference 필드 mutation은 하지 않으므로
 * (toolInput, contextItems, agentInfo 등 object reference 필드는 같은 노드에 대해 동일),
 * 같은 treeNodeId의 이전 ChatMessage와 새로 만든 ChatMessage가 shallowEqual이면
 * 이전 reference를 그대로 재사용한다.
 *
 * 이 identity 보존 덕분에 VirtualizedItem(React.memo)이 props 변경 없음으로
 * 인식하여 재렌더를 건너뛴다 → flashing 해소.
 *
 * 세션 전환 시에는 session-slice가 clearFlattenTreeCache()를 호출하여
 * 이전 세션 항목이 새 세션에 누설되지 않도록 한다.
 */
const messageCache = new Map<string, ChatMessage>();

/** 캐시를 비운다. 세션 전환 시 호출. */
export function clearFlattenTreeCache(): void {
  messageCache.clear();
}

/**
 * ChatMessage 모든 필드를 얕게 비교한다.
 *
 * - primitive (string, number, boolean): === (값 비교)
 * - object reference (toolInput, contextItems, agentInfo, questions, usage): === (reference)
 *
 * Reference 비교 안전성: tree-placer는 children push만 하고 노드의 toolInput 등
 * object reference 필드를 재할당하지 않는다. 같은 treeNodeId를 두 번 traverse하면
 * 해당 필드의 reference는 동일하므로 === 충분.
 *
 * content/isStreaming은 text_delta로 갱신될 수 있으나 string/boolean이라 자동 값 비교.
 */
function shallowEqualChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.content === b.content &&
    a.timestamp === b.timestamp &&
    a.thinkingContent === b.thinkingContent &&
    a.toolName === b.toolName &&
    a.toolDurationMs === b.toolDurationMs &&
    a.isError === b.isError &&
    a.toolInput === b.toolInput &&
    a.toolResult === b.toolResult &&
    a.isStreaming === b.isStreaming &&
    a.usage === b.usage &&
    a.totalCostUsd === b.totalCostUsd &&
    a.durationMs === b.durationMs &&
    a.treeNodeId === b.treeNodeId &&
    a.treeNodeType === b.treeNodeType &&
    a.model === b.model &&
    a.provider === b.provider &&
    a.isTruncated === b.isTruncated &&
    a.fullContentEventId === b.fullContentEventId &&
    a.questions === b.questions &&
    a.requestId === b.requestId &&
    a.responded === b.responded &&
    a.expired === b.expired &&
    a.receivedAt === b.receivedAt &&
    a.timeoutSec === b.timeoutSec &&
    a.contextItems === b.contextItems &&
    a.agentInfo === b.agentInfo &&
    a.callerInfo === b.callerInfo &&
    a.eventId === b.eventId
  );
}

/**
 * 이벤트 트리를 flat한 ChatMessage 리스트로 변환합니다.
 *
 * - session 루트 노드는 skip (children만 순회)
 * - 각 노드 타입별 ChatMessage 변환
 * - children 재귀: Phase 2-A 평탄화 후엔 root.children 1depth 평면이라 결과적으로 1회 순회.
 *   재귀 코드는 안전망으로 유지 — 향후 옵션 A 전환(events 배열 직역)이나 다른 트리 구조
 *   재도입 시 호환성을 잃지 않도록.
 * - identity 보존: 같은 treeNodeId의 이전 ChatMessage가 shallowEqual이면 재사용
 *   (atom b0c41f5c — VirtualizedItem React.memo 동작에 필수, 평탄화 후에도 보존)
 */
export function flattenTree(root: EventTreeNode | null): ChatMessage[] {
  if (!root) return [];

  const messages: ChatMessage[] = [];
  collectMessages(root, messages);
  return messages;
}

/** 캐시 조회·갱신 후 reference를 반환한다. */
function intern(treeNodeId: string, fresh: ChatMessage): ChatMessage {
  const cached = messageCache.get(treeNodeId);
  if (cached && shallowEqualChatMessage(cached, fresh)) {
    return cached;
  }
  messageCache.set(treeNodeId, fresh);
  return fresh;
}

function collectMessages(
  node: EventTreeNode,
  out: ChatMessage[],
): void {
  // session 루트: pid가 있으면 시스템 메시지로 표시
  if (node.type === "session") {
    const sessionNode = node as SessionNode;
    if (sessionNode.pid != null) {
      const sessionPidId = `${node.id}-pid`;
      const fresh: ChatMessage = {
        id: sessionPidId,
        role: "system",
        content: `Process ID: ${sessionNode.pid}`,
        treeNodeId: node.id,
        treeNodeType: "session",
      };
      out.push(intern(sessionPidId, fresh));
    }
  } else {
    const msg = nodeToMessage(node);
    if (msg) out.push(intern(msg.treeNodeId, msg));
  }

  // result 노드가 complete 보다 먼저 오는 경우를 보정:
  // complete → result 순서가 되도록 children을 정렬 (해당 노드가 있을 때만)
  //
  // Phase 2-A 평탄화 (atom 작업 이력 260507.01.fe-tree-flattening §11.2 유지 결정):
  //   백엔드 검증 결과 result/complete는 같은 user_message의 자식(형제)으로 emit되며,
  //   task_executor가 parent_event_id를 채운다. 송출 순서는 SDK 비동기 타이밍에 따라
  //   역전 가능 (코드상 result→complete이지만 eventId ASC 보장 없음).
  //   본 정렬 보정은 *백엔드 결함 우회*가 아니라 **UX 정책** —
  //   "Session Complete (요약·비용·duration) → result 텍스트" 순서를 강제한다.
  //   평탄화 후 root.children 1depth에서도 동일 동작 (needsSort 가드는 트리 단계 무관).
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

/** 트리 노드 ID (node-{type}-{eventId}) 에서 DB 이벤트 ID를 추출한다 */
function extractEventId(nodeId: string): number | undefined {
  const match = nodeId.match(/-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function nodeToMessage(node: EventTreeNode): ChatMessage | null {
  const eventId = extractEventId(node.id);
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
        eventId,
        contextItems: n.context,
        agentInfo: n.agentInfo,
        callerInfo: n.callerInfo,
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
        eventId,
      };
    }

    case "intervention": {
      const n = node as InterventionNode;
      // F-9 fix(2026-05-08): callerInfo·agentInfo를 ChatMessage에 forward하여
      // InterventionMessage가 발신자-단위 아바타·이름을 표시하게 한다.
      return {
        id: n.id,
        role: "intervention",
        content: n.content,
        timestamp: n.timestamp,
        treeNodeId: n.id,
        treeNodeType: n.type,
        eventId,
        agentInfo: n.agentInfo,
        callerInfo: n.callerInfo,
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
        eventId,
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
        eventId,
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
        eventId,
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
        eventId,
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
        eventId,
      };
    }

    case "away_summary": {
      return {
        id: node.id,
        role: "away_summary",
        content: node.content,
        timestamp: node.timestamp,
        treeNodeId: node.id,
        treeNodeType: node.type,
        eventId,
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
        eventId,
      };
    }

    default:
      return null;
  }
}
