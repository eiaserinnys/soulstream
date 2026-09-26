import type { SSEEventType } from './types';
import {
  SSE_EVENT_TYPES as GENERATED_SSE_EVENT_TYPES,
  type SSEEventType as GeneratedSSEEventType,
} from "@soulstream/wire-schema";

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

// init/reconnected는 provider가 직접 처리한다. 세 이벤트는 현재 UI handler가 없어
// 구독 목록에서 제외하고, 추가 시에는 handler와 함께 이 목록을 갱신한다.
type _SSEExcludedTypes =
  | "init"
  | "reconnected"
  | "realtime_status"
  | "realtime_transcript"
  | "session_ended";
const SSE_EXCLUDED_TYPES: ReadonlySet<_SSEExcludedTypes> = new Set([
  "init",
  "reconnected",
  "realtime_status",
  "realtime_transcript",
  "session_ended",
]);

export const SSE_EVENT_TYPES = GENERATED_SSE_EVENT_TYPES.filter(
  (eventType): eventType is Exclude<GeneratedSSEEventType, _SSEExcludedTypes> =>
    !SSE_EXCLUDED_TYPES.has(eventType as _SSEExcludedTypes),
) satisfies readonly Exclude<SSEEventType, _SSEExcludedTypes>[];

// 컴파일 타임 검증: 시스템 이벤트를 제외한 모든 SSEEventType이 SSE_EVENT_TYPES에 포함되는지 확인
type _AssertHandledEventTypesCovered = {
  [K in Exclude<SSEEventType, _SSEExcludedTypes>]: K extends (typeof SSE_EVENT_TYPES)[number] ? true : never
};
