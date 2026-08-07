import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import {
  deleteBoardYjsItem,
  getBoardYjsContainerDocumentName,
  readBoardYDocReplica,
} from "./board_yjs_model.js";
import type {
  BoardYjsContainerScope,
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
} from "./board_yjs_types.js";

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

export async function withStagedBoardItemRemoval<T>(
  hocuspocus: Hocuspocus,
  boardItems: readonly CatalogBoardItemRow[],
  persist: (applications: readonly BoardYjsDocumentApplication[]) => Promise<T>,
): Promise<T> {
  const removals = groupRemovals(boardItems);
  const connections: Array<{
    connection: DirectConnection;
    live: Y.Doc;
    staged: Y.Doc;
    scope: BoardYjsContainerScope;
  }> = [];
  try {
    for (const removal of removals) {
      const connection = await hocuspocus.openDirectConnection(removal.documentName, {
        containerKind: removal.scope.containerKind,
        containerId: removal.scope.containerId,
        source: "session-delete",
      });
      const live = connection.document as unknown as Y.Doc | null;
      if (!live) {
        await connection.disconnect();
        throw new Error(`board Y.Doc direct connection closed: ${removal.documentName}`);
      }
      const staged = clone(live);
      for (const boardItemId of removal.boardItemIds) {
        deleteBoardYjsItem(staged, boardItemId);
      }
      connections.push({ connection, live, staged, scope: removal.scope });
    }

    const applications = connections.map(({ scope, staged }) => ({
      documentName: getBoardYjsContainerDocumentName(scope),
      scope,
      snapshot: Y.encodeStateAsUpdate(staged),
      replica: readBoardYDocReplica(scope, staged),
    }));
    const updates = connections.map(({ live, staged }) =>
      Y.encodeStateAsUpdate(staged, Y.encodeStateVector(live))
    );
    const result = await persist(applications);
    for (const [index, entry] of connections.entries()) {
      await entry.connection.transact((document) => {
        Y.applyUpdate(document as unknown as Y.Doc, updates[index]!);
      });
    }
    return result;
  } finally {
    for (const { connection } of connections.reverse()) {
      await connection.disconnect();
    }
  }
}

export function boardItemRemovalDocumentNames(
  boardItems: readonly CatalogBoardItemRow[],
): string[] {
  return groupRemovals(boardItems).map((removal) => removal.documentName);
}

function groupRemovals(boardItems: readonly CatalogBoardItemRow[]): Array<{
  documentName: string;
  scope: BoardYjsContainerScope;
  boardItemIds: string[];
}> {
  if (boardItems.length === 0) {
    throw new Error("staged board item removal requires at least one board item");
  }
  const grouped = new Map<string, {
    documentName: string;
    scope: BoardYjsContainerScope;
    boardItemIds: string[];
  }>();
  for (const boardItem of boardItems) {
    const scope = scopeOf(boardItem);
    const documentName = getBoardYjsContainerDocumentName(scope);
    const existing = grouped.get(documentName);
    if (existing) {
      if (existing.scope.folderId !== scope.folderId) {
        throw new Error(`board Y.Doc folder mismatch: ${documentName}`);
      }
      existing.boardItemIds.push(boardItem.id);
    } else {
      grouped.set(documentName, { documentName, scope, boardItemIds: [boardItem.id] });
    }
  }
  return [...grouped.values()]
    .map((removal) => ({
      ...removal,
      boardItemIds: [...new Set(removal.boardItemIds)].sort(),
    }))
    .sort((left, right) => left.documentName.localeCompare(right.documentName));
}

function scopeOf(boardItem: CatalogBoardItemRow): BoardYjsContainerScope {
  return {
    folderId: boardItem.folderId,
    containerKind: boardItem.containerKind ?? "folder",
    containerId: boardItem.containerId ?? boardItem.folderId,
  };
}

function clone(source: Y.Doc): Y.Doc {
  const target = new Y.Doc();
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
  return target;
}
