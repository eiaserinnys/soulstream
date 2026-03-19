/** 세션 관련 타입 정의. */

export interface SessionSummary {
  sessionId: string;
  status: string;
  createdAt?: string;
  lastMessage?: string;
  [key: string]: unknown;
}

export interface AggregatedSession {
  nodeId: string;
  sessionId: string;
  summary: SessionSummary;
}

export interface SessionEvent {
  type: string;
  session_id: string;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionListChangeEvent {
  type: "session_added" | "session_updated" | "session_removed";
  nodeId: string;
  session: AggregatedSession;
}

export interface CreateSessionRequest {
  prompt: string;
  profile?: string;
  nodeId?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  use_mcp?: boolean;
}
