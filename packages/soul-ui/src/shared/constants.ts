import type { SSEEventType } from './types';

export const SYSTEM_FOLDER_IDS = {
  claude: "claude",
  llm: "llm",
} as const;

export type SystemFolderKey = keyof typeof SYSTEM_FOLDER_IDS;
export type SystemFolderId = (typeof SYSTEM_FOLDER_IDS)[SystemFolderKey];

export const SYSTEM_FOLDERS = {
  claude: '⚙️ 클로드 코드 세션',
  llm: '⚙️ LLM 세션',
} as const satisfies Readonly<Record<SystemFolderKey, string>>;

export const DEFAULT_FOLDER_KEY = 'claude' as const;
export const DEFAULT_FOLDER_ID = SYSTEM_FOLDER_IDS[DEFAULT_FOLDER_KEY];

const SYSTEM_FOLDER_ID_SET: ReadonlySet<string> = new Set(Object.values(SYSTEM_FOLDER_IDS));

export function isSystemFolderId(folderId: string | null | undefined): folderId is SystemFolderId {
  return typeof folderId === "string" && SYSTEM_FOLDER_ID_SET.has(folderId);
}

// "init": 연결 초기화 시 발행되는 내부 이벤트 (SSESessionProvider가 직접 처리)
// "reconnected": 재연결 후 발행되는 내부 이벤트 (SSESessionProvider가 직접 처리)
type _SSEExcludedTypes = "init" | "reconnected";

export const SSE_EVENT_TYPES = [
  "progress",
  "memory",
  "session",
  "intervention_sent",
  "user_message",
  "system_message",
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
  "agent_updated",
  "handoff_requested",
  "handoff_occurred",
  "tool_approval_requested",
  "tool_approval_resolved",
  "guardrail_tripwire",
  "result",
  "away_summary",
  "prompt_suggestion",
  "subagent_start",
  "subagent_stop",
  "claude_runtime_session_state",
  "claude_runtime_task_started",
  "claude_runtime_task_created",
  "claude_runtime_task_updated",
  "claude_runtime_task_progress",
  "claude_runtime_task_completed",
  "claude_runtime_task_notification",
  "claude_runtime_notification",
  "claude_runtime_remote_trigger",
  "claude_runtime_transcript_mirror_error",
  "claude_runtime_hook_event",
  "claude_runtime_mode_state",
  "claude_runtime_schedule_updated",
  "claude_runtime_schedule_deleted",
  "context_usage",
  "compact",
  "assistant_error",
  "credential_alert",
  "reconnect",
  "history_sync",
  "metadata_updated",
  "subtree_update",
] as const satisfies readonly Exclude<SSEEventType, _SSEExcludedTypes>[];

// 컴파일 타임 검증: 시스템 이벤트를 제외한 모든 SSEEventType이 SSE_EVENT_TYPES에 포함되는지 확인
type _AssertHandledEventTypesCovered = {
  [K in Exclude<SSEEventType, _SSEExcludedTypes>]: K extends (typeof SSE_EVENT_TYPES)[number] ? true : never
};
