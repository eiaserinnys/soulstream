import type {
  SessionBoardMoveInput,
  StagedSessionBoardMove,
} from "../board-yjs/board_yjs_move.js";
import type {
  BoardYjsFolderScope,
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
} from "../board-yjs/board_yjs_types.js";

interface SessionBoardMoveBoardPort {
  withSessionBoardMoveApplications<T>(
    input: SessionBoardMoveInput,
    persist: (move: StagedSessionBoardMove) => Promise<T>,
  ): Promise<CatalogBoardItemRow | null>;
}

export interface MovedAssignedCard { cardId: string; sourceFolderId: string; folderId: string; }

export interface SessionTreeMoveCommit { cards: readonly MovedAssignedCard[]; folderIds: readonly string[]; }

interface SessionBoardMoveRepositoryPort {
  listSessionMoveTree(sessionIds: readonly string[]): Promise<string[]>;
  listSessionBoardItems(sessionId: string): Promise<CatalogBoardItemRow[]>;
  commitSessionMove(input: {
    sessionId: string;
    sessionIds: readonly string[];
    folderId: string | null;
    boardApplications: readonly BoardYjsDocumentApplication[];
  }): Promise<SessionTreeMoveCommit | void>;
}

export class SessionBoardMoveService {
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(private readonly config: {
    board: SessionBoardMoveBoardPort;
    repository: SessionBoardMoveRepositoryPort;
    onFoldersMoveCommitted?: (folderIds: readonly string[]) => Promise<void>;
    onCardsMoveCommitted?: (cards: readonly MovedAssignedCard[]) => Promise<void>;
    /** Board/Yjs path only. REST catalog mutations emit through their route wrapper. */
    onBoardMoveCommitted?: (move: {
      sessionId: string;
      sessionIds: readonly string[];
      folderId: string | null;
    }) => Promise<void>;
  }) {}

  async moveSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<CatalogBoardItemRow | null> {
    // REST catalog routes wrap their provider with withSessionCatalogMutationBroadcasts.
    // Do not emit here too, or the same committed move produces two catalog deltas.
    return (await this.moveRoots([sessionId], {
      sessionId,
      targetScope: folderId === null ? null : { folderId },
    }, false)).moved;
  }

  async moveSessionsToFolder(sessionIds: readonly string[], folderId: string | null) {
    if (!sessionIds.length) return { count: 0, sessionIds: [] };
    const result = await this.moveRoots(sessionIds, {
      sessionId: sessionIds[0]!,
      targetScope: folderId === null ? null : { folderId },
    }, false);
    return { count: result.sessionIds.length, sessionIds: result.sessionIds };
  }

  async moveSessionBoardItem(input: {
    sessionId: string;
    targetScope: BoardYjsFolderScope | null;
    position?: { x: number; y: number };
  }): Promise<CatalogBoardItemRow | null> {
    return (await this.moveRoots([input.sessionId], input, true)).moved;
  }

  private async moveRoots(
    roots: readonly string[],
    input: {
      sessionId: string;
      targetScope: BoardYjsFolderScope | null;
      position?: { x: number; y: number };
    },
    emitBoardCatalogDelta: boolean,
  ): Promise<{ moved: CatalogBoardItemRow | null; sessionIds: string[] }> {
    const sessionIds = await this.config.repository.listSessionMoveTree(roots);
    const lockedIds = [...sessionIds].sort();
    const lock = async (index: number): Promise<{ moved: CatalogBoardItemRow | null; sessionIds: string[] }> =>
      index < sessionIds.length
        ? this.withSessionLock(lockedIds[index]!, () => lock(index + 1))
        : work();
    const work = async () => {
      const boardItems = (await Promise.all(sessionIds.map(id =>
        this.config.repository.listSessionBoardItems(id)))).flat();
      let committed: SessionTreeMoveCommit = {cards:[],folderIds:[]};
      const moved = await this.config.board.withSessionBoardMoveApplications(
        {
          sessionId: input.sessionId,
          sessionIds,
          boardItems,
          targetScope: input.targetScope,
          ...(input.position ? { position: input.position } : {}),
        },
        async ({ movedBoardItem, boardApplications }) => {
          committed = await this.config.repository.commitSessionMove({
            sessionId: input.sessionId,
            sessionIds,
            folderId: input.targetScope?.folderId ?? null,
            boardApplications,
          }) ?? {cards:[],folderIds:[]};
          return movedBoardItem;
        },
      );
      // withSessionBoardMoveApplications returns only after BoardYjsMoveRepository's transaction
      // (Yjs application + session_assign_folder) and the live Yjs update both succeed.
      await this.config.onCardsMoveCommitted?.(committed.cards);
      await this.config.onFoldersMoveCommitted?.(committed.folderIds);
      if (emitBoardCatalogDelta) {
        await this.config.onBoardMoveCommitted?.({
          sessionId: input.sessionId,
          sessionIds,
          folderId: input.targetScope?.folderId ?? null,
        });
      }
      return { moved, sessionIds };
    };
    return await lock(0);
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
