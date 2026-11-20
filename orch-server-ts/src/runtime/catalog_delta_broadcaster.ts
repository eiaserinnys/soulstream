import type { CatalogBoardItemsDelta, CatalogSessionsDelta } from "@soulstream/wire-schema/catalog";
import type { FolderRecord } from "../folders/folder_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export type CatalogDelta = {
  readonly sessionsDelta?: CatalogSessionsDelta;
  readonly boardItemsDelta?: CatalogBoardItemsDelta<unknown>;
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
