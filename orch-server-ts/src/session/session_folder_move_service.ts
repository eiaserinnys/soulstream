export interface MovedAssignedCard { cardId: string; sourceFolderId: string; folderId: string; }
export interface SessionTreeMoveCommit { cards: readonly MovedAssignedCard[]; folderIds: readonly string[]; }

interface SessionFolderMoveRepositoryPort {
  listSessionMoveTree(sessionIds: readonly string[]): Promise<string[]>;
  areSessionAssignmentsInFolder(sessionIds: readonly string[], folderId: string | null): Promise<boolean>;
  commitSessionMove(input: {
    sessionId: string;
    sessionIds: readonly string[];
    folderId: string | null;
  }): Promise<SessionTreeMoveCommit>;
}

export class SessionFolderMoveService {
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(private readonly config: {
    repository: SessionFolderMoveRepositoryPort;
    onFoldersMoveCommitted?: (folderIds: readonly string[]) => Promise<void>;
    onCardsMoveCommitted?: (cards: readonly MovedAssignedCard[]) => Promise<void>;
  }) {}

  async moveSessionToFolder(sessionId: string, folderId: string | null): Promise<void> {
    await this.moveSessionsToFolder([sessionId], folderId);
  }

  async moveSessionsToFolder(sessionIds: readonly string[], folderId: string | null):
    Promise<{ count: number; sessionIds: string[]; didCommit: boolean }> {
    if (!sessionIds.length) return { count: 0, sessionIds: [], didCommit: false };
    const tree = await this.config.repository.listSessionMoveTree(sessionIds);
    const lockedIds = [...tree].sort();
    const work = async () => {
      if (!tree.length || await this.config.repository.areSessionAssignmentsInFolder(tree, folderId)) {
        return { count: tree.length, sessionIds: tree, didCommit: false };
      }
      const committed = await this.config.repository.commitSessionMove({ sessionId: sessionIds[0]!, sessionIds: tree, folderId });
      await this.config.onCardsMoveCommitted?.(committed.cards);
      await this.config.onFoldersMoveCommitted?.(committed.folderIds);
      return { count: tree.length, sessionIds: tree, didCommit: true };
    };
    const lock = (index: number): ReturnType<typeof work> => index < lockedIds.length
      ? this.withSessionLock(lockedIds[index]!, () => lock(index + 1)) : work();
    return await lock(0);
  }

  private async withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.sessionTails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try { return await work(); }
    finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }
}
