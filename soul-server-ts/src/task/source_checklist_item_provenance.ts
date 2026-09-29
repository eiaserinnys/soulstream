import type { Logger } from "pino";

import type { FolderSnapshot } from "../db/session_db.js";

const REJECTION_MESSAGE =
  "source checklist item provenance rejected; continuing without provenance";

export async function resolveSourceChecklistItemProvenance(params: {
  sessionId: string;
  sourceChecklistItemId?: string | null;
  folderId?: string | null;
  getFolderSnapshot(folderId: string): Promise<FolderSnapshot | null>;
  logger: Pick<Logger, "warn">;
}): Promise<string | null> {
  const sourceChecklistItemId = params.sourceChecklistItemId ?? null;
  if (sourceChecklistItemId === null) return null;
  if (!params.folderId) {
    params.logger.warn({ sessionId: params.sessionId, sourceChecklistItemId, reason: "folder_missing" }, REJECTION_MESSAGE);
    return null;
  }

  let snapshot: FolderSnapshot | null;
  try {
    snapshot = await params.getFolderSnapshot(params.folderId);
  } catch (err) {
    params.logger.warn({ err, sessionId: params.sessionId, sourceChecklistItemId, folderId: params.folderId, reason: "validation_failed" }, REJECTION_MESSAGE);
    return null;
  }

  if (snapshot?.items.some((item) => item.id === sourceChecklistItemId)) {
    return sourceChecklistItemId;
  }
  params.logger.warn({ sessionId: params.sessionId, sourceChecklistItemId, folderId: params.folderId, reason: "checklist_item_not_found" }, REJECTION_MESSAGE);
  return null;
}
