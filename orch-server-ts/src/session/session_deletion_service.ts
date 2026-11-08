export interface SessionDeletionPort {
  deleteSession(sessionId: string): Promise<void>;
}

export interface SessionDeletionRepositoryPort {
  deleteSession(input: { sessionId: string }): Promise<void>;
}

export class SessionDeletionService implements SessionDeletionPort {
  constructor(private readonly config: { repository: SessionDeletionRepositoryPort }) {}

  async deleteSession(sessionId: string): Promise<void> {
    await this.config.repository.deleteSession({ sessionId });
  }
}
