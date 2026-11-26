import {
  SSE_EVENT_TYPES as GENERATED_SSE_EVENT_TYPES,
  type SSEEventType,
} from "@soulstream/wire-schema";

export const SYSTEM_FOLDER_IDS = {
  claude: "claude",
  llm: "llm",
} as const;

export type SystemFolderKey = keyof typeof SYSTEM_FOLDER_IDS;
export type SystemFolderId = (typeof SYSTEM_FOLDER_IDS)[SystemFolderKey];

export const DEFAULT_FOLDER_KEY = 'claude' as const;
export const DEFAULT_FOLDER_ID = SYSTEM_FOLDER_IDS[DEFAULT_FOLDER_KEY];

const SYSTEM_FOLDER_ID_SET: ReadonlySet<string> = new Set(Object.values(SYSTEM_FOLDER_IDS));

export function isSystemFolderId(folderId: string | null | undefined): folderId is SystemFolderId {
  return typeof folderId === "string" && SYSTEM_FOLDER_ID_SET.has(folderId);
}

type _SSEExcludedTypes =
  | "init"
  | "realtime_status"
  | "realtime_transcript"
  | "session_ended";
const SSE_EXCLUDED_TYPES: ReadonlySet<_SSEExcludedTypes> = new Set([
  "init",
  "realtime_status",
  "realtime_transcript",
  "session_ended",
]);

export const SSE_EVENT_TYPES = GENERATED_SSE_EVENT_TYPES.filter(
  (eventType): eventType is Exclude<SSEEventType, _SSEExcludedTypes> =>
    !SSE_EXCLUDED_TYPES.has(eventType as _SSEExcludedTypes),
) satisfies readonly Exclude<SSEEventType, _SSEExcludedTypes>[];
