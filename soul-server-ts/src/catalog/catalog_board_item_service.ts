import { randomUUID } from "node:crypto";

import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  SessionDB,
} from "../db/session_db.js";

const BOARD_GRID_SIZE = 20;
const BOARD_TILE_WIDTH = 280;
const BOARD_TILE_HEIGHT = 160;
const BOARD_DEFAULT_COLUMNS = 4;

export interface CatalogBoardItemMoveResult {
  boardItem: CatalogBoardItemRow;
  enrolled: boolean;
}

export interface CatalogBoardYjsPort {
  updateBoardItemPosition(
    container: string | BoardYjsContainerRef,
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void>;
  moveBoardItemToContainer(input: {
    boardItem: CatalogBoardItemRow;
    targetScope: {
      folderId: string;
      containerKind: BoardYjsContainerRef["containerKind"];
      containerId: string;
    };
    position?: { x: number; y: number };
  }): Promise<CatalogBoardItemRow>;
  createMarkdownDocument(input: {
    folderId: string;
    container?: BoardYjsContainerRef;
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }>;
  updateMarkdownDocument(
    container: string | BoardYjsContainerRef,
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null>;
  deleteMarkdownDocument(
    container: string | BoardYjsContainerRef,
    documentId: string,
  ): Promise<void>;
  upsertSessionBoardItem(input: {
    folderId: string;
    container: BoardYjsContainerRef;
    sessionId: string;
    x: number;
    y: number;
    sourceRunbookItemId?: string | null;
  }): Promise<CatalogBoardItemRow>;
}

export class CatalogBoardItemService {
  constructor(
    private readonly db: SessionDB,
    private readonly boardYjsService: CatalogBoardYjsPort | undefined,
    private readonly broadcastCatalog: () => Promise<void>,
  ) {}

  async updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    const snappedX = snapBoardPosition(x);
    const snappedY = snapBoardPosition(y);
    if (this.boardYjsService) {
      const boardItem = await this.db.getBoardItemById(boardItemId);
      if (boardItem) {
        await this.boardYjsService.updateBoardItemPosition(
          {
            containerKind: boardItem.containerKind ?? "folder",
            containerId: boardItem.containerId ?? boardItem.folderId,
          },
          boardItemId,
          snappedX,
          snappedY,
        );
        await this.broadcastCatalog();
        return;
      }
    }
    await this.db.ensureBoardItems();
    await this.db.updateBoardItemPosition(
      boardItemId,
      snappedX,
      snappedY,
    );
    await this.broadcastCatalog();
  }

  async moveBoardItemToContainer(params: {
    boardItemId: string;
    target: BoardYjsContainerRef;
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemMoveResult> {
    if (!this.boardYjsService) {
      throw new Error("board Yjs service is not configured");
    }
    assertSupportedMoveItemId(params.boardItemId);
    await this.db.ensureBoardItems();
    const targetScope = await this.db.resolveBoardYjsContainerScope(params.target);
    if (!targetScope) {
      throw new Error(`target container not found: ${params.target.containerKind}:${params.target.containerId}`);
    }
    const targetContainer = containerRefFromScope(targetScope);
    const snappedPosition = params.position
      ? {
          x: snapBoardPosition(params.position.x),
          y: snapBoardPosition(params.position.y),
        }
      : undefined;
    const boardItem = await this.db.getBoardItemById(params.boardItemId);
    if (!boardItem) {
      const enrolled = await this.enrollGeneratedSessionBoardItem({
        boardItemId: params.boardItemId,
        targetScope,
        targetContainer,
        position: snappedPosition,
      });
      if (enrolled) {
        await this.broadcastCatalog();
        return { boardItem: enrolled, enrolled: true };
      }
      throw new Error(`board item not found: ${params.boardItemId}`);
    }
    if ((boardItem.membershipKind ?? "primary") !== "primary") {
      throw new Error("only primary board item membership can be moved");
    }
    if (!isMovableBoardItemType(boardItem.itemType)) {
      throw new Error(`board item type is not movable: ${boardItem.itemType}`);
    }
    const sourceKind = boardItem.containerKind ?? "folder";
    const sourceId = boardItem.containerId ?? boardItem.folderId;

    if (sourceKind === targetScope.containerKind && sourceId === targetScope.containerId) {
      if (snappedPosition) {
        await this.updateBoardItemPosition(
          boardItem.id,
          snappedPosition.x,
          snappedPosition.y,
        );
        return {
          boardItem: {
            ...boardItem,
            x: snappedPosition.x,
            y: snappedPosition.y,
          },
          enrolled: false,
        };
      }
      return { boardItem, enrolled: false };
    }

    const previousSessionFolderId = boardItem.itemType === "session"
      ? (await this.db.getSession(boardItem.itemId))?.folder_id ?? null
      : null;
    if (boardItem.itemType === "session") {
      await this.db.assignSessionToFolder(boardItem.itemId, targetScope.folderId);
    }

    try {
      const moved = await this.boardYjsService.moveBoardItemToContainer({
        boardItem,
        targetScope,
        ...(snappedPosition ? { position: snappedPosition } : {}),
      });
      await this.broadcastCatalog();
      return { boardItem: moved, enrolled: false };
    } catch (err) {
      if (
        boardItem.itemType === "session" &&
        previousSessionFolderId !== null &&
        isSourceYDocMissingError(err)
      ) {
        try {
          const enrolled = await this.enrollSessionBoardItem({
            sessionId: boardItem.itemId,
            targetScope,
            targetContainer,
            position: snappedPosition,
            sourceRunbookItemId: boardItem.sourceRunbookItemId ?? null,
          });
          await this.broadcastCatalog();
          return { boardItem: enrolled, enrolled: true };
        } catch (fallbackErr) {
          await this.db.assignSessionToFolder(boardItem.itemId, previousSessionFolderId);
          throw fallbackErr;
        }
      }
      if (boardItem.itemType === "session") {
        await this.db.assignSessionToFolder(boardItem.itemId, previousSessionFolderId);
      }
      throw err;
    }
  }

  async createMarkdownDocument(params: {
    folderId: string;
    container?: BoardYjsContainerRef | null;
    title: string;
    body?: string;
    x?: number;
    y?: number;
  }): Promise<Awaited<ReturnType<SessionDB["createMarkdownDocument"]>>> {
    const documentId = randomUUID();
    const container = params.container ?? {
      containerKind: "folder" as const,
      containerId: params.folderId,
    };
    const [x, y] = params.x !== undefined && params.y !== undefined
      ? [snapBoardPosition(params.x), snapBoardPosition(params.y)]
      : await this.nextBoardPosition(params.folderId, container);
    if (this.boardYjsService) {
      const result = await this.boardYjsService.createMarkdownDocument({
        documentId,
        folderId: params.folderId,
        container,
        title: params.title,
        body: params.body ?? "",
        x,
        y,
      });
      await this.broadcastCatalog();
      return result;
    }
    const result = await this.db.createMarkdownDocument({
      documentId,
      folderId: params.folderId,
      container,
      title: params.title,
      body: params.body ?? "",
      x,
      y,
    });
    await this.broadcastCatalog();
    return result;
  }

  async getMarkdownDocument(documentId: string) {
    return this.db.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ) {
    if (fields.title === undefined && fields.body === undefined) {
      return this.getMarkdownDocument(documentId);
    }
    if (this.boardYjsService) {
      const boardItem = await this.db.getMarkdownDocumentBoardItem(documentId);
      if (boardItem) {
        const document = await this.boardYjsService.updateMarkdownDocument(
          {
            containerKind: boardItem.containerKind ?? "folder",
            containerId: boardItem.containerId ?? boardItem.folderId,
          },
          documentId,
          fields,
        );
        await this.broadcastCatalog();
        return document;
      }
    }
    const document = await this.db.updateMarkdownDocument(documentId, fields);
    await this.broadcastCatalog();
    return document;
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    if (this.boardYjsService) {
      const boardItem = await this.db.getMarkdownDocumentBoardItem(documentId);
      if (boardItem) {
        await this.boardYjsService.deleteMarkdownDocument(
          {
            containerKind: boardItem.containerKind ?? "folder",
            containerId: boardItem.containerId ?? boardItem.folderId,
          },
          documentId,
        );
        await this.broadcastCatalog();
        return;
      }
    }
    await this.db.deleteMarkdownDocument(documentId);
    await this.broadcastCatalog();
  }

  private async nextBoardPosition(
    folderId: string,
    container: BoardYjsContainerRef,
  ): Promise<[number, number]> {
    // Legacy REST/MCP markdown placement. Board catalog reads are Yjs-derived.
    await this.db.ensureBoardItems();
    const occupied = new Set(
      (await this.db.getBoardItems())
        .filter((item) =>
          item.folderId === folderId &&
          (item.containerKind ?? "folder") === container.containerKind &&
          (item.containerId ?? item.folderId) === container.containerId
        )
        .map((item) => `${item.x}:${item.y}`),
    );
    let index = 0;
    while (true) {
      const x = (index % BOARD_DEFAULT_COLUMNS) * BOARD_TILE_WIDTH;
      const y = Math.floor(index / BOARD_DEFAULT_COLUMNS) * BOARD_TILE_HEIGHT;
      if (!occupied.has(`${x}:${y}`)) return [x, y];
      index += 1;
    }
  }

  private async enrollGeneratedSessionBoardItem(params: {
    boardItemId: string;
    targetScope: BoardYjsContainerScope;
    targetContainer: BoardYjsContainerRef;
    position?: { x: number; y: number };
  }): Promise<CatalogBoardItemRow | null> {
    const sessionId = sessionIdFromBoardItemId(params.boardItemId);
    if (!sessionId) return null;

    const session = await this.db.getSession(sessionId);
    if (!session?.folder_id) return null;
    if (session.folder_id !== params.targetScope.folderId) return null;

    return await this.enrollSessionBoardItem({
      sessionId,
      targetScope: params.targetScope,
      targetContainer: params.targetContainer,
      position: params.position,
      sourceRunbookItemId: null,
    });
  }

  private async enrollSessionBoardItem(params: {
    sessionId: string;
    targetScope: BoardYjsContainerScope;
    targetContainer: BoardYjsContainerRef;
    position?: { x: number; y: number };
    sourceRunbookItemId: string | null;
  }): Promise<CatalogBoardItemRow> {
    const [x, y] = params.position
      ? [params.position.x, params.position.y]
      : await this.nextBoardPosition(params.targetScope.folderId, params.targetContainer);
    await this.db.assignSessionToFolder(params.sessionId, params.targetScope.folderId);
    return await this.boardYjsService!.upsertSessionBoardItem({
      folderId: params.targetScope.folderId,
      container: params.targetContainer,
      sessionId: params.sessionId,
      sourceRunbookItemId: params.sourceRunbookItemId,
      x,
      y,
    });
  }
}

function containerRefFromScope(scope: BoardYjsContainerScope): BoardYjsContainerRef {
  return {
    containerKind: scope.containerKind,
    containerId: scope.containerId,
  };
}

function snapBoardPosition(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

function assertSupportedMoveItemId(boardItemId: string): void {
  if (!boardItemId.trim()) {
    throw new Error("boardItemId is required");
  }
}

function sessionIdFromBoardItemId(boardItemId: string): string | null {
  if (!boardItemId.startsWith("session:")) return null;
  const sessionId = boardItemId.slice("session:".length);
  return sessionId.trim() ? sessionId : null;
}

function isSourceYDocMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("board item not found in source Y.Doc");
}

function isMovableBoardItemType(
  itemType: CatalogBoardItemRow["itemType"],
): itemType is Extract<CatalogBoardItemRow["itemType"], "session" | "markdown" | "asset" | "custom_view"> {
  return itemType === "session" ||
    itemType === "markdown" ||
    itemType === "asset" ||
    itemType === "custom_view";
}
