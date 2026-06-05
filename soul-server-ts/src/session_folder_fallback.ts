import type { SessionDB } from "./db/session_db.js";

export interface SessionFolderFallbackDeps {
  db: Pick<SessionDB, "getSession">;
  logger: {
    warn(obj: unknown, msg: string): void;
  };
}

export function hasExplicitFolderId<T extends { folderId?: string | null }>(
  params: T,
): boolean {
  return Object.prototype.hasOwnProperty.call(params, "folderId")
    && params.folderId !== undefined;
}

export async function getCallerSessionFolderId(
  deps: SessionFolderFallbackDeps,
  callerSessionId: string,
): Promise<string | null> {
  try {
    const row = await deps.db.getSession(callerSessionId);
    return row?.folder_id ?? null;
  } catch (err) {
    deps.logger.warn(
      { err, callerSessionId },
      "caller session folder lookup failed",
    );
    return null;
  }
}

export async function resolveDelegatedFolderId(
  deps: SessionFolderFallbackDeps,
  params: {
    callerSessionId: string;
    folderId?: string | null;
  },
): Promise<string | null> {
  if (hasExplicitFolderId(params)) {
    return params.folderId ?? null;
  }
  return getCallerSessionFolderId(deps, params.callerSessionId);
}
