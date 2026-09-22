import type {
  SessionBoardMoveInput,
  StagedSessionBoardMove,
} from "../board-yjs/board_yjs_move.js";
import type {
  BoardYjsContainerScope,
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
} from "../board-yjs/board_yjs_types.js";

interface SessionBoardMoveBoardPort {
  withSessionBoardMoveApplications<T>(
    input: SessionBoardMoveInput,
    persist: (move: StagedSessionBoardMove) => Promise<T>,
  ): Promise<CatalogBoardItemRow | null>;
}

interface SessionBoardMoveRepositoryPort {
  listSessionBoardItems(sessionId: string): Promise<CatalogBoardItemRow[]>;
  commitSessionMove(input: {
    sessionId: string;
    folderId: string | null;
    boardApplications: readonly BoardYjsDocumentApplication[];
  }): Promise<void>;
}

export class SessionBoardMoveService {
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(private readonly config: {
    board: SessionBoardMoveBoardPort;
    repository: SessionBoardMoveRepositoryPort;
    /** Board/Yjs path only. REST catalog mutations emit through their route wrapper. */
    onBoardMoveCommitted?: (move: {
      sessionId: string;
      folderId: string | null;
    }) => Promise<void>;
  }) {}

  async moveSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<CatalogBoardItemRow | null> {
    // REST catalog routes wrap their provider with withSessionCatalogMutationBroadcasts.
    // Do not emit here too, or the same committed move produces two catalog deltas.
    return await this.moveSessionBoardItemInternal({
      sessionId,
      targetScope: folderId === null
        ? null
        : { folderId, containerKind: "folder", containerId: folderId },
      sourceTaskItemId: null,
    }, false);
  }

  async moveSessionBoardItem(input: {
    sessionId: string;
    targetScope: BoardYjsContainerScope | null;
    position?: { x: number; y: number };
    sourceTaskItemId?: string | null;
  }): Promise<CatalogBoardItemRow | null> {
    return await this.moveSessionBoardItemInternal(input, true);
  }

  private async moveSessionBoardItemInternal(
    input: {
      sessionId: string;
      targetScope: BoardYjsContainerScope | null;
      position?: { x: number; y: number };
      sourceTaskItemId?: string | null;
    },
    emitBoardCatalogDelta: boolean,
  ): Promise<CatalogBoardItemRow | null> {
    return await this.withSessionLock(input.sessionId, async () => {
      const boardItems = await this.config.repository.listSessionBoardItems(input.sessionId);
      const moved = await this.config.board.withSessionBoardMoveApplications(
        {
          sessionId: input.sessionId,
          boardItems,
          targetScope: input.targetScope,
          ...(input.position ? { position: input.position } : {}),
          sourceTaskItemId: input.sourceTaskItemId ?? null,
        },
        async ({ movedBoardItem, boardApplications }) => {
          await this.config.repository.commitSessionMove({
            sessionId: input.sessionId,
            folderId: input.targetScope?.folderId ?? null,
            boardApplications,
          });
          return movedBoardItem;
        },
      );
      // withSessionBoardMoveApplications returns only after BoardYjsMoveRepository's transaction
      // (Yjs application + session_assign_folder) and the live Yjs update both succeed.
      if (emitBoardCatalogDelta) {
        await this.config.onBoardMoveCommitted?.({
          sessionId: input.sessionId,
          folderId: input.targetScope?.folderId ?? null,
        });
      }
      return moved;
    });
  }

  private async withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.sessionTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }
}
