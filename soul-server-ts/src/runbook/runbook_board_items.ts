import type { CatalogBoardItemRow } from "../db/session_db_types.js";

import type { RunbookRepository } from "./runbook_repository.js";
import type { RunbookMutationResult } from "./runbook_service_models.js";

export interface RunbookBoardYjsPort {
  upsertRunbookBoardItem(input: {
    folderId: string;
    boardItemId: string;
    runbookId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow>;
  removeRunbookBoardItem(folderId: string, boardItemId: string): Promise<void>;
}

export async function resolveRunbookIdempotent(
  repo: RunbookRepository,
  idempotencyKey?: string | null,
): Promise<RunbookMutationResult | null> {
  if (!idempotencyKey) return null;
  const operation = await repo.getOperationByIdempotencyKey(idempotencyKey);
  if (!operation?.runbook_id) return null;
  const snapshot = await repo.getSnapshot(operation.runbook_id);
  if (!snapshot) throw new Error(`runbook not found: ${operation.runbook_id}`);
  return {
    snapshot,
    operation,
    eventId: operation.actor_event_id ?? 0,
    idempotent: true,
  };
}

export async function upsertRunbookBoardItem(
  boardYjsService: RunbookBoardYjsPort,
  params: {
    folderId: string;
    boardItemId: string;
    runbookId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await boardYjsService.upsertRunbookBoardItem(params);
}

export async function removeRunbookBoardItemIfUnlinked(
  repo: RunbookRepository,
  boardYjsService: RunbookBoardYjsPort,
  params: {
    folderId: string;
    boardItemId: string;
    runbookId: string;
  },
): Promise<void> {
  if (await repo.getRunbook(params.runbookId)) return;
  await boardYjsService.removeRunbookBoardItem(params.folderId, params.boardItemId);
}

export async function updateRunbookBoardItemTitle(
  repo: RunbookRepository,
  boardYjsService: RunbookBoardYjsPort,
  runbookId: string,
  title: string,
): Promise<void> {
  const boardItem = await repo.getRunbookBoardItem(runbookId);
  if (!boardItem) throw new Error(`runbook board item not found: ${runbookId}`);
  await boardYjsService.upsertRunbookBoardItem({
    folderId: boardItem.folder_id,
    boardItemId: boardItem.id,
    runbookId: boardItem.item_id,
    title,
    x: Number(boardItem.x),
    y: Number(boardItem.y),
    metadata: metadataRecord(boardItem.metadata),
  });
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}
