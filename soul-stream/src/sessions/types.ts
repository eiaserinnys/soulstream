/** 세션 관련 타입 정의. */

export interface SessionSummary {
  sessionId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  lastMessage?: unknown; // soul-server가 {preview, timestamp, type} 객체를 보냄
  prompt?: string;
  folderId?: string | null; // sessions 테이블의 folder_id 컬럼. null = 폴더 미배정
}

export interface AggregatedSession {
  nodeId: string;
  sessionId: string;
  summary: SessionSummary;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface SessionEvent {
  id?: number; // DB 이벤트 ID (soul-server WS event 메시지의 event_id 필드)
  type: string;
  session_id: string;
  event?: Record<string, unknown>;
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
