/**
 * The system folder a session lands in when the caller does not name a folder.
 * The same rule the dashboard applies to sessions created without a folder:
 * llm sessions go to `llm`, every other session goes to `claude`.
 * `soul-server-ts/src/system_folders.ts` keeps the server-side copy; keep both in step.
 */
export type SystemDefaultFolderId = "claude" | "llm";

export function defaultFolderIdForSessionType(
  sessionType: string,
): SystemDefaultFolderId {
  return sessionType === "llm" ? "llm" : "claude";
}
