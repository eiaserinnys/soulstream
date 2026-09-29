import type { SessionDB } from "./db/session_db.js";

export interface SessionFolderFallbackDeps {
  db: Pick<SessionDB, "getSession">;
  logger: { warn(obj: unknown, msg: string): void };
}

/** An explicit folder always wins; otherwise inherit the caller session's folder. */
export async function resolveDelegatedFolderId(
  deps: SessionFolderFallbackDeps,
  params: { callerSessionId?: string | null; folderId?: string | null },
): Promise<string | null> {
  if (Object.prototype.hasOwnProperty.call(params, "folderId")) {
    return params.folderId ?? null;
  }
  if (!params.callerSessionId) return null;
  try {
    const row = await deps.db.getSession(params.callerSessionId);
    return row?.folder_id ?? null;
  } catch (err) {
    deps.logger.warn({ err, callerSessionId: params.callerSessionId }, "caller session folder lookup failed");
    return null;
  }
}
