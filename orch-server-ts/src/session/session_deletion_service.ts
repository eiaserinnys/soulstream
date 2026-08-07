import type {
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
} from "../board-yjs/board_yjs_types.js";

export type SessionDeletionBoardApplication = BoardYjsDocumentApplication;

export interface SessionDeletionPort {
  deleteSession(sessionId: string): Promise<void>;
}

export interface SessionDeletionBoardPort {
  withBoardItemRemovalApplications<T>(
    boardItems: readonly CatalogBoardItemRow[],
    persist: (applications: readonly SessionDeletionBoardApplication[]) => Promise<T>,
  ): Promise<T>;
}

export interface SessionDeletionRepositoryPort {
  listSessionBoardItems(sessionId: string): Promise<CatalogBoardItemRow[]>;
  deleteSession(input: {
    sessionId: string;
    boardApplications: readonly SessionDeletionBoardApplication[];
  }): Promise<void>;
}

export class SessionDeletionService implements SessionDeletionPort {
  constructor(private readonly config: {
    board: SessionDeletionBoardPort;
    repository: SessionDeletionRepositoryPort;
  }) {}

  async deleteSession(sessionId: string): Promise<void> {
    const boardItems = await this.config.repository.listSessionBoardItems(sessionId);
    if (boardItems.length === 0) {
      await this.config.repository.deleteSession({ sessionId, boardApplications: [] });
      return;
    }
    await this.config.board.withBoardItemRemovalApplications(
      boardItems,
      async (boardApplications) => {
        await this.config.repository.deleteSession({ sessionId, boardApplications });
      },
    );
  }
}
