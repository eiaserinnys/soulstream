/**
 * Soul Dashboard - 이벤트 트리 노드 타입 정의
 *
 * SSE 이벤트 lifecycle을 단일 노드로 표현하는 EventTreeNode discriminated union.
 * dashboard-store가 SSE 이벤트를 흡수하여 만드는 트리 표현의 source of truth입니다.
 */

import type { ContextItem, InputRequestQuestion } from "./sse-events";

/** 트리 노드 타입 (SSE 이벤트 lifecycle → 단일 노드) */
export type EventTreeNodeType = EventTreeNode["type"];

// === EventTreeNode Discriminated Union ===

/** 모든 노드 타입의 공통 필드 */
interface BaseNode {
  id: string;
  children: EventTreeNode[];
  content: string;
  completed: boolean;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parentEventId?: string;
  /** 이벤트 발행 시각 (Unix epoch, 초) */
  timestamp?: number;
}

/** 가상 세션 루트 노드 */
export interface SessionNode extends BaseNode {
  type: "session";
  sessionId?: string;
  pid?: number;
  /** 세션 유형 */
  sessionType?: "claude" | "llm";
  /** LLM 프로바이더 */
  llmProvider?: string;
  /** LLM 모델명 */
  llmModel?: string;
}

/** 사용자 메시지 노드 */
export interface UserMessageNode extends BaseNode {
  type: "user_message";
  user: string;
  context?: ContextItem[];
  /** 에이전트가 발신한 경우 채워지는 메타데이터 */
  agentInfo?: {
    source: "agent";
    agent_node: string;
    agent_id: string | null;
    agent_name: string | null;
  };
}

/** 시스템 메시지 노드 (system_message 이벤트 → 노드) */
export interface SystemMessageNode extends BaseNode {
  type: "system_message";
}

/** 인터벤션 노드 */
export interface InterventionNode extends BaseNode {
  type: "intervention";
  user?: string;
}

/** Thinking (확장 사고) 노드 */
export interface ThinkingNode extends BaseNode {
  type: "thinking";
  /** 콘텐츠가 truncate 되었는지 여부 */
  isTruncated?: boolean;
  /** truncate된 경우, 전체 내용을 가진 원본 이벤트 ID */
  fullContentEventId?: number;
}

/** 텍스트 노드 */
export interface TextNode extends BaseNode {
  type: "text";
  /** text_end 수신 여부 */
  textCompleted?: boolean;
}

/** 도구 호출 노드 */
export interface ToolNode extends BaseNode {
  type: "tool" | "tool_use";
  /** SDK ToolUseBlock.id (tool_result 매칭용) */
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  durationMs?: number;
  /** 콘텐츠가 truncate 되었는지 여부 */
  isTruncated?: boolean;
  /** truncate된 경우, 전체 내용을 가진 원본 이벤트 ID */
  fullContentEventId?: number;
}

/** 세션 결과 노드 */
export interface ResultNode extends BaseNode {
  type: "result";
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
  stopReason?: string;
  errors?: string[];
  modelUsage?: Record<string, unknown>;
  permissionDenials?: string[];
}

/** 컨텍스트 압축 노드 */
export interface CompactNode extends BaseNode {
  type: "compact";
}

/** 세션 완료 노드 */
export interface CompleteNode extends BaseNode {
  type: "complete";
}

/** 에러 노드 */
export interface ErrorNode extends BaseNode {
  type: "error";
  isError?: boolean;
}

/** 사용자 입력 요청 노드 */
export interface InputRequestNodeDef extends BaseNode {
  type: "input_request";
  requestId: string;
  toolUseId?: string;
  questions: InputRequestQuestion[];
  responded?: boolean;
  expired?: boolean;
  receivedAt?: number;
  timeoutSec?: number;
  serverExpiredAt?: number;  // 서버 만료 이벤트 수신 시각 (ms) — expired=true 즉시 설정 방지용
}

/** LLM 프록시 어시스턴트 응답 노드 */
export interface AssistantMessageNode extends BaseNode {
  type: "assistant_message";
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Claude API 에러 노드 (인증 실패, 과금 에러 등) */
export interface AssistantErrorNode extends BaseNode {
  type: "assistant_error";
  errorType: string;
  model?: string;
  messageId?: string;
}

/** 이벤트 트리 노드 — 소스 오브 트루스 (discriminated union) */
export type EventTreeNode =
  | SessionNode
  | UserMessageNode
  | SystemMessageNode
  | InterventionNode
  | ThinkingNode
  | TextNode
  | ToolNode
  | ResultNode
  | CompactNode
  | CompleteNode
  | ErrorNode
  | InputRequestNodeDef
  | AssistantMessageNode
  | AssistantErrorNode;
