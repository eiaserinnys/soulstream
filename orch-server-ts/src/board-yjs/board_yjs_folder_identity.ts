import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { getBoardYjsDocumentName, readBoardYDocReplica, BOARD_ITEMS_MAP } from "./board_yjs_document.js";
import { nextBoardPosition, upsertBoardYjsItem } from "./board_yjs_model.js";
import type { BoardYjsDocumentApplication, BoardYjsItemValue, CatalogBoardItemRow } from "./board_yjs_types.js";

export interface FolderBoardIdentityInput {
  folderId: string;
  parentFolderId: string | null;
  previousParentFolderId: string | null;
  title: string;
  archived: boolean;
}

export function folderIdentityDocumentNames(input: FolderBoardIdentityInput): string[] {
  return [...new Set([input.previousParentFolderId, input.parentFolderId].filter((id): id is string => id !== null))]
    .sort().map(getBoardYjsDocumentName);
}

/** Stage the existing primary tile without changing its opaque id or placement. */
export async function withFolderBoardIdentity<T>(
  host: Hocuspocus, input: FolderBoardIdentityInput,
  persist: (applications: BoardYjsDocumentApplication[]) => Promise<T>,
): Promise<T> {
  type Connection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
  const entries: { connection: Connection; live: Y.Doc; staged: Y.Doc; folderId: string; name: string }[] = [];
  try {
    for (const name of folderIdentityDocumentNames(input)) {
      const folderId = name.slice("board-folder:".length);
      const connection = await host.openDirectConnection(name, { folderId, source: "folder-identity" });
      const live = connection.document as unknown as Y.Doc | null;
      if (!live) { await connection.disconnect(); throw new Error(`Board document closed: ${name}`); }
      const staged = new Y.Doc(); Y.applyUpdate(staged, Y.encodeStateAsUpdate(live));
      entries.push({ connection, live, staged, folderId, name });
    }
    let existing: CatalogBoardItemRow | undefined;
    for (const entry of entries) {
      const item = readBoardYDocReplica(entry.folderId, entry.staged).boardItems.find(row =>
        row.itemType === "subfolder" && row.itemId === input.folderId && row.membershipKind !== "reference");
      if (item) existing = item;
      if (item && entry.folderId !== input.parentFolderId) entry.staged.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).delete(item.id);
    }
    const target = entries.find(entry => entry.folderId === input.parentFolderId);
    if (target) {
      const [x, y] = existing ? [existing.x, existing.y] : nextBoardPosition(readBoardYDocReplica(target.folderId, target.staged).boardItems);
      upsertBoardYjsItem(target.staged, {
        ...existing, id: existing?.id ?? `subfolder:${input.folderId}`, itemType: "subfolder", itemId: input.folderId,
        folderId: target.folderId, x, y, membershipKind: "primary",
        metadata: { ...existing?.metadata, name: input.title, archived: input.archived },
      });
    }
    const result = await persist(entries.map(entry => ({ documentName: entry.name,
      scope: { folderId: entry.folderId }, snapshot: Y.encodeStateAsUpdate(entry.staged),
      replica: readBoardYDocReplica(entry.folderId, entry.staged) })));
    for (const entry of entries) {
      const update = Y.encodeStateAsUpdate(entry.staged, Y.encodeStateVector(entry.live));
      await entry.connection.transact(doc => { Y.applyUpdate(doc as unknown as Y.Doc, update); });
    }
    return result;
  } finally {
    for (const entry of entries.reverse()) { entry.staged.destroy(); await entry.connection.disconnect(); }
  }
}
