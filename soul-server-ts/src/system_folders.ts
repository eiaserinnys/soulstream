export const SYSTEM_FOLDER_IDS = Object.freeze({
  claude: "claude",
  llm: "llm",
} as const);

export type SystemFolderKey = keyof typeof SYSTEM_FOLDER_IDS;
export type SystemFolderId = (typeof SYSTEM_FOLDER_IDS)[SystemFolderKey];

export const DEFAULT_FOLDERS = Object.freeze({
  claude: "⚙️ 클로드 코드 세션",
  llm: "⚙️ LLM 세션",
} satisfies Readonly<Record<SystemFolderKey, string>>);

const SYSTEM_FOLDER_ID_SET: ReadonlySet<string> = new Set(Object.values(SYSTEM_FOLDER_IDS));

export function isSystemFolderId(folderId: string | null | undefined): folderId is SystemFolderId {
  return typeof folderId === "string" && SYSTEM_FOLDER_ID_SET.has(folderId);
}

export function defaultFolderIdForSessionType(sessionType: string): SystemFolderId {
  return sessionType === SYSTEM_FOLDER_IDS.llm
    ? SYSTEM_FOLDER_IDS.llm
    : SYSTEM_FOLDER_IDS.claude;
}

export function assertMutableFolder(folderId: string, operation: string): void {
  if (!isSystemFolderId(folderId)) return;
  throw new Error(`System folder '${folderId}' cannot be ${operation}.`);
}
