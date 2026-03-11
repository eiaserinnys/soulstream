/**
 * 공유 데이터 변환 함수
 *
 * 서버 응답(snake_case)을 클라이언트 타입(camelCase)으로 변환합니다.
 * SSESessionProvider와 useSessionListProvider 양쪽에서 단일 함수를 공유합니다.
 */

import type { SessionSummary, SessionStatus } from "./types";

/**
 * 서버 응답(snake_case)을 SessionSummary(camelCase)로 변환합니다.
 *
 * 서버의 _task_to_session_info()는 agent_session_id, created_at, updated_at,
 * session_type을 보냅니다. eventCount는 포함하지 않을 수 있습니다.
 */
export function toSessionSummary(raw: Record<string, unknown>): SessionSummary {
  return {
    agentSessionId: (raw.agent_session_id ?? raw.agentSessionId) as string,
    status: (raw.status as SessionStatus) ?? "unknown",
    eventCount: (raw.event_count ?? raw.eventCount ?? 0) as number,
    createdAt: (raw.created_at ?? raw.createdAt) as string | undefined,
    completedAt: (raw.updated_at ?? raw.completedAt) as string | undefined,
    prompt: raw.prompt as string | undefined,
    sessionType: (raw.session_type ?? raw.sessionType) as "claude" | "llm" | undefined,
  };
}
