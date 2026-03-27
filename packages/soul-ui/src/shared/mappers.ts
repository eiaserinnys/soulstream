/**
 * 공유 데이터 변환 함수
 *
 * 서버 응답(snake_case)을 클라이언트 타입(camelCase)으로 변환합니다.
 * SSESessionProvider와 useSessionListProvider 양쪽에서 단일 함수를 공유합니다.
 */

import type { SessionSummary, SessionStatus, LlmUsage, MetadataEntry } from "./types";

/** snake_case / camelCase 양쪽 응답을 LlmUsage로 변환 */
function toLlmUsage(raw: unknown): LlmUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    inputTokens: (r.input_tokens ?? r.inputTokens ?? 0) as number,
    outputTokens: (r.output_tokens ?? r.outputTokens ?? 0) as number,
  };
}

/**
 * 서버 응답(snake_case)을 SessionSummary(camelCase)로 변환합니다.
 *
 * 서버의 _task_to_session_info()는 agent_session_id, created_at, updated_at,
 * session_type을 보냅니다. eventCount는 포함하지 않을 수 있습니다.
 */
export function toSessionSummary(raw: Record<string, unknown>): SessionSummary {
  const lastMsg = (raw.last_message ?? raw.lastMessage) as
    | Record<string, unknown>
    | undefined;
  return {
    agentSessionId: (raw.agent_session_id ?? raw.agentSessionId) as string,
    status: (raw.status as SessionStatus) ?? "unknown",
    eventCount: (raw.event_count ?? raw.eventCount ?? 0) as number,
    createdAt: (raw.created_at ?? raw.createdAt) as string | undefined,
    updatedAt: (raw.updated_at ?? raw.updatedAt) as string | undefined,
    completedAt: (raw.completed_at ?? raw.completedAt) as string | undefined,
    prompt: raw.prompt as string | undefined,
    sessionType: (raw.session_type ?? raw.sessionType) as "claude" | "llm" | undefined,
    llmProvider: (raw.llm_provider ?? raw.llmProvider) as string | undefined,
    llmModel: (raw.llm_model ?? raw.llmModel) as string | undefined,
    llmUsage: toLlmUsage(raw.llm_usage ?? raw.llmUsage),
    clientId: (raw.client_id ?? raw.clientId) as string | undefined,
    lastMessage: lastMsg
      ? {
          type: lastMsg.type as string,
          preview: lastMsg.preview as string,
          timestamp: lastMsg.timestamp as string,
        }
      : undefined,
    metadata: (raw.metadata as MetadataEntry[] | undefined) ?? [],
    lastEventId: (raw.last_event_id ?? raw.lastEventId ?? 0) as number,
    lastReadEventId: (raw.last_read_event_id ?? raw.lastReadEventId ?? 0) as number,
    nodeId: (raw.node_id ?? raw.nodeId) as string | undefined,
    agentId: (raw.agent_id ?? raw.agentId) as string | undefined,
    agentName: (raw.agent_name ?? raw.agentName) as string | undefined,
    agentPortraitUrl: (raw.agent_portrait_url ?? raw.agentPortraitUrl) as string | undefined,
  };
}
