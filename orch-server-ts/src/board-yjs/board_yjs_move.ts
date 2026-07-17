import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import {
  deleteMovedBoardYjsItem,
  getBoardYjsContainerDocumentName,
  readBoardYDocReplica,
  readMovableBoardYjsItem,
  upsertMovedBoardYjsItem,
} from "./board_yjs_model.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  CatalogBoardItemRow,
} from "./board_yjs_types.js";

export interface BoardMoveInput {
  boardItem: CatalogBoardItemRow;
  targetScope: BoardYjsContainerScope;
  position?: { x: number; y: number };
}

export interface StagedBoardApplication {
  documentName: string;
  scope: BoardYjsContainerScope;
  snapshot: Uint8Array;
  replica: ReturnType<typeof readBoardYDocReplica>;
}

export interface StagedRunbookBoardMove {
  movedBoardItem: CatalogBoardItemRow;
  boardApplications: readonly StagedBoardApplication[];
}

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

export async function moveBoardItemBetweenDocuments(
  hocuspocus: Hocuspocus,
  input: BoardMoveInput,
): Promise<CatalogBoardItemRow> {
  const sourceContainer = sourceContainerOf(input.boardItem);
  const source = await open(hocuspocus, sourceContainer);
  const targetContainer = containerOf(input.targetScope);
  let targetApplied = false;
  try {
    const moved = await readMovedItem(source, input);
    if (!moved) {
      const target = await open(hocuspocus, targetContainer);
      try {
        const existing = await readMovedItem(target, input);
        if (existing) return existing.boardItem;
      } finally {
        await target.disconnect();
      }
      throw new Error(`board item not found in source Y.Doc: ${input.boardItem.id}`);
    }
    const target = await open(hocuspocus, targetContainer);
    try {
      await target.transact((document) => {
        upsertMovedBoardYjsItem(document as unknown as Y.Doc, moved);
      });
      targetApplied = true;
      await source.transact((document) => {
        deleteMovedBoardYjsItem(document as unknown as Y.Doc, moved);
      });
      return moved.boardItem;
    } catch (error) {
      if (targetApplied) {
        await target.transact((document) => {
          deleteMovedBoardYjsItem(document as unknown as Y.Doc, moved);
        });
      }
      throw error;
    } finally {
      await target.disconnect();
    }
  } finally {
    await source.disconnect();
  }
}

export async function withStagedRunbookBoardMove(
  hocuspocus: Hocuspocus,
  input: BoardMoveInput,
  persist: (application: StagedRunbookBoardMove) => Promise<void>,
): Promise<CatalogBoardItemRow> {
  const sourceScope = scopeOf(input.boardItem);
  const targetScope = input.targetScope;
  const source = await open(hocuspocus, sourceScope);
  const target = await open(hocuspocus, targetScope);
  try {
    const sourceLive = requireDocument(source, sourceScope);
    const targetLive = requireDocument(target, targetScope);
    const sourceStaged = clone(sourceLive);
    const targetStaged = clone(targetLive);
    const moved = readMovableBoardYjsItem(
      sourceStaged,
      input.boardItem.id,
      targetScope,
      input.position,
    );
    if (!moved) {
      throw new Error(`board item not found in source Y.Doc: ${input.boardItem.id}`);
    }
    if (moved.boardItem.itemType !== "runbook") {
      throw new Error(`staged task identity move requires runbook: ${moved.boardItem.itemType}`);
    }
    upsertMovedBoardYjsItem(targetStaged, moved);
    deleteMovedBoardYjsItem(sourceStaged, moved);

    const sourceUpdate = Y.encodeStateAsUpdate(sourceStaged, Y.encodeStateVector(sourceLive));
    const targetUpdate = Y.encodeStateAsUpdate(targetStaged, Y.encodeStateVector(targetLive));
    await persist({
      movedBoardItem: moved.boardItem,
      boardApplications: [
        application(sourceScope, sourceStaged),
        application(targetScope, targetStaged),
      ],
    });
    await target.transact((document) => {
      Y.applyUpdate(document as unknown as Y.Doc, targetUpdate);
    });
    await source.transact((document) => {
      Y.applyUpdate(document as unknown as Y.Doc, sourceUpdate);
    });
    return moved.boardItem;
  } finally {
    await target.disconnect();
    await source.disconnect();
  }
}

function application(scope: BoardYjsContainerScope, document: Y.Doc): StagedBoardApplication {
  return {
    documentName: getBoardYjsContainerDocumentName(scope),
    scope,
    snapshot: Y.encodeStateAsUpdate(document),
    replica: readBoardYDocReplica(scope, document),
  };
}

function scopeOf(item: CatalogBoardItemRow): BoardYjsContainerScope {
  return {
    folderId: item.folderId,
    containerKind: item.containerKind ?? "folder",
    containerId: item.containerId ?? item.folderId,
  };
}

function sourceContainerOf(item: CatalogBoardItemRow): BoardYjsContainerRef {
  return containerOf(scopeOf(item));
}

function containerOf(scope: BoardYjsContainerScope): BoardYjsContainerRef {
  return { containerKind: scope.containerKind, containerId: scope.containerId };
}

function open(hocuspocus: Hocuspocus, container: BoardYjsContainerRef) {
  return hocuspocus.openDirectConnection(
    getBoardYjsContainerDocumentName(container),
    { ...container, source: "server" },
  );
}

function requireDocument(connection: DirectConnection, scope: BoardYjsContainerRef): Y.Doc {
  const document = connection.document as unknown as Y.Doc | null;
  if (!document) {
    throw new Error(`board Y.Doc direct connection closed: ${getBoardYjsContainerDocumentName(scope)}`);
  }
  return document;
}

function clone(source: Y.Doc): Y.Doc {
  const target = new Y.Doc();
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
  return target;
}

async function readMovedItem(
  connection: DirectConnection,
  input: BoardMoveInput,
): Promise<ReturnType<typeof readMovableBoardYjsItem>> {
  let result: ReturnType<typeof readMovableBoardYjsItem> = null;
  await connection.transact((document) => {
    result = readMovableBoardYjsItem(
      document as unknown as Y.Doc,
      input.boardItem.id,
      input.targetScope,
      input.position,
    );
  });
  return result;
}
