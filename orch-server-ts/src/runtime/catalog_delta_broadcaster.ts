import type { FolderRecord, SessionAssignmentRecord } from "../folders/folder_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export type CatalogSessionsDelta = Record<string, SessionAssignmentRecord | null>;
export type CatalogBoardItemsDelta = Record<string, unknown | null>;

export type CatalogDelta = {
  readonly sessionsDelta?: CatalogSessionsDelta;
  readonly boardItemsDelta?: CatalogBoardItemsDelta;
};

export type CatalogDeltaFolderProvider = {
  listFolders: () => Promise<readonly FolderRecord[]> | readonly FolderRecord[];
};

export async function broadcastCatalogDelta(
  provider: CatalogDeltaFolderProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  delta: CatalogDelta = {},
): Promise<void> {
  broadcaster.append({
    type: "catalog_updated",
    folders: await provider.listFolders(),
    sessions_delta: delta.sessionsDelta ?? {},
    board_items_delta: delta.boardItemsDelta ?? {},
  });
}

export function deletedBoardItemsDelta(
  boardItemIds: readonly string[],
): CatalogBoardItemsDelta {
  return Object.fromEntries(boardItemIds.map((boardItemId) => [boardItemId, null]));
}
