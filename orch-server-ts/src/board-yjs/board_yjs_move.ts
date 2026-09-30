import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import {
  deleteBoardYjsItem,
  deleteMovedBoardYjsItem,
  getBoardYjsContainerDocumentName,
  nextBoardPosition,
  readBoardYDocReplica,
  readMovableBoardYjsItem,
  upsertBoardYjsItem,
  upsertMovedBoardYjsItem,
} from "./board_yjs_model.js";
import type {
  BoardYjsFolderScope,
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
} from "./board_yjs_types.js";

export interface BoardMoveInput {
  boardItem: CatalogBoardItemRow;
  targetScope: BoardYjsFolderScope;
  position?: { x: number; y: number };
}

export type StagedBoardApplication = BoardYjsDocumentApplication;

export interface StagedBoardMove {
  movedBoardItem: CatalogBoardItemRow;
  boardApplications: readonly StagedBoardApplication[];
}


export interface SessionBoardMoveInput {
  sessionId: string;
  boardItems: readonly CatalogBoardItemRow[];
  targetScope: BoardYjsFolderScope | null;
  position?: { x: number; y: number };
}

export interface StagedSessionBoardMove {
  movedBoardItem: CatalogBoardItemRow | null;
  boardApplications: readonly StagedBoardApplication[];
}

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

export async function withStagedBoardMove(
  hocuspocus: Hocuspocus,
  input: BoardMoveInput,
  persist: (application: StagedBoardMove) => Promise<void>,
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

export async function withStagedSessionBoardMove(
  hocuspocus: Hocuspocus,
  input: SessionBoardMoveInput,
  persist: (application: StagedSessionBoardMove) => Promise<void>,
): Promise<CatalogBoardItemRow | null> {
  const primaryItems = input.boardItems.filter((item) =>
    item.itemType === "session" &&
    item.itemId === input.sessionId &&
    (item.membershipKind ?? "primary") === "primary"
  );
  const scopes = sessionMoveScopes(primaryItems, input.targetScope);
  if (scopes.length === 0) {
    await persist({ movedBoardItem: null, boardApplications: [] });
    return null;
  }
  const connections: Array<{
    scope: BoardYjsFolderScope;
    connection: DirectConnection;
    live: Y.Doc;
    staged: Y.Doc;
  }> = [];
  try {
    for (const scope of scopes) {
      const connection = await open(hocuspocus, scope);
      const live = requireDocument(connection, scope);
      connections.push({ scope, connection, live, staged: clone(live) });
    }
    const byDocumentName = new Map(connections.map((entry) => [
      getBoardYjsContainerDocumentName(entry.scope),
      entry,
    ]));
    for (const boardItem of primaryItems) {
      const entry = byDocumentName.get(getBoardYjsContainerDocumentName(scopeOf(boardItem)));
      if (entry) deleteBoardYjsItem(entry.staged, boardItem.id);
    }

    const movedBoardItem = input.targetScope
      ? createTargetSessionItem(
          input,
          input.targetScope,
          primaryItems,
          requireEntry(byDocumentName, input.targetScope).staged,
        )
      : null;
    if (movedBoardItem && input.targetScope) {
      upsertBoardYjsItem(requireEntry(byDocumentName, input.targetScope).staged, movedBoardItem);
    }

    const boardApplications = connections.map(({ scope, staged }) =>
      application(scope, staged)
    );
    const updates = connections.map(({ live, staged }) =>
      Y.encodeStateAsUpdate(staged, Y.encodeStateVector(live))
    );
    await persist({ movedBoardItem, boardApplications });
    for (const [index, entry] of connections.entries()) {
      await entry.connection.transact((document) => {
        Y.applyUpdate(document as unknown as Y.Doc, updates[index]!);
      });
    }
    return movedBoardItem;
  } finally {
    for (const { connection } of connections.reverse()) {
      await connection.disconnect();
    }
  }
}

export function sessionBoardMoveDocumentNames(input: SessionBoardMoveInput): string[] {
  const primaryItems = input.boardItems.filter((item) =>
    item.itemType === "session" &&
    item.itemId === input.sessionId &&
    (item.membershipKind ?? "primary") === "primary"
  );
  return sessionMoveScopes(primaryItems, input.targetScope).map((scope) =>
    getBoardYjsContainerDocumentName(scope)
  );
}

export function boardMoveDocumentNames(input: BoardMoveInput): string[] {
  return [
    getBoardYjsContainerDocumentName(scopeOf(input.boardItem)),
    getBoardYjsContainerDocumentName(input.targetScope),
  ];
}

function application(scope: BoardYjsFolderScope, document: Y.Doc): StagedBoardApplication {
  return {
    documentName: getBoardYjsContainerDocumentName(scope),
    scope,
    snapshot: Y.encodeStateAsUpdate(document),
    replica: readBoardYDocReplica(scope, document),
  };
}

function scopeOf(item: CatalogBoardItemRow): BoardYjsFolderScope {
  return {
    folderId: item.folderId,
  };
}

function open(hocuspocus: Hocuspocus, container: BoardYjsFolderScope) {
  return hocuspocus.openDirectConnection(
    getBoardYjsContainerDocumentName(container),
    { ...container, source: "server" },
  );
}

function requireDocument(connection: DirectConnection, scope: BoardYjsFolderScope): Y.Doc {
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

function sessionMoveScopes(
  primaryItems: readonly CatalogBoardItemRow[],
  targetScope: BoardYjsFolderScope | null,
): BoardYjsFolderScope[] {
  const scopes = new Map<string, BoardYjsFolderScope>();
  for (const item of primaryItems) {
    const scope = scopeOf(item);
    scopes.set(getBoardYjsContainerDocumentName(scope), scope);
  }
  if (targetScope) {
    scopes.set(getBoardYjsContainerDocumentName(targetScope), targetScope);
  }
  return [...scopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
}

function requireEntry(
  entries: ReadonlyMap<string, { staged: Y.Doc }>,
  scope: BoardYjsFolderScope,
): { staged: Y.Doc } {
  const documentName = getBoardYjsContainerDocumentName(scope);
  const entry = entries.get(documentName);
  if (!entry) throw new Error(`staged board document missing: ${documentName}`);
  return entry;
}

function createTargetSessionItem(
  input: SessionBoardMoveInput,
  targetScope: BoardYjsFolderScope,
  primaryItems: readonly CatalogBoardItemRow[],
  targetDocument: Y.Doc,
): CatalogBoardItemRow {
  const existingTarget = primaryItems.find((item) =>
    item.folderId === targetScope.folderId
  );
  const source = existingTarget ?? primaryItems[0];
  const position = input.position ?? (source
    ? { x: source.x, y: source.y }
    : positionObject(nextBoardPosition(readBoardYDocReplica(targetScope, targetDocument).boardItems)));
  return {
    id: `session:${input.sessionId}`,
    folderId: targetScope.folderId,
    membershipKind: "primary",
    itemType: "session",
    itemId: input.sessionId,
    x: position.x,
    y: position.y,
    metadata: source?.metadata ?? {},
    ...(source?.createdAt ? { createdAt: source.createdAt } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function positionObject([x, y]: readonly [number, number]): { x: number; y: number } {
  return { x, y };
}
