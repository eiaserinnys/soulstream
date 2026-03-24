import type { SSEEventType } from './types';

export const SYSTEM_FOLDERS = {
  claude: '⚙️ 클로드 코드 세션',
  llm: '⚙️ LLM 세션',
} as const;

export const DEFAULT_FOLDER_KEY = 'claude' as const;

// "init": 연결 초기화 시 발행되는 내부 이벤트 (SSESessionProvider가 직접 처리)
// "reconnected": 재연결 후 발행되는 내부 이벤트 (SSESessionProvider가 직접 처리)
type _SSEExcludedTypes = "init" | "reconnected";

export const SSE_EVENT_TYPES = [
  "progress",
  "memory",
  "session",
  "intervention_sent",
  "user_message",
  "assistant_message",
  "input_request",
  "input_request_expired",
  "input_request_responded",
  "debug",
  "complete",
  "error",
  "thinking",
  "text_start",
  "text_delta",
  "text_end",
  "tool_start",
  "tool_result",
  "result",
  "subagent_start",
  "subagent_stop",
  "context_usage",
  "compact",
  "reconnect",
  "history_sync",
  "metadata_updated",
] as const satisfies readonly Exclude<SSEEventType, _SSEExcludedTypes>[];

// 컴파일 타임 검증: 시스템 이벤트를 제외한 모든 SSEEventType이 SSE_EVENT_TYPES에 포함되는지 확인
type _AssertHandledEventTypesCovered = {
  [K in Exclude<SSEEventType, _SSEExcludedTypes>]: K extends (typeof SSE_EVENT_TYPES)[number] ? true : never
};
