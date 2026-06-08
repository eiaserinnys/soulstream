export class TaskHydrationFailedError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`Task hydration failed: ${sessionId}`, { cause });
    this.name = "TaskHydrationFailedError";
  }
}

export class TaskOwnedByAnotherNodeError extends Error {
  constructor(sessionId: string, ownerNodeId: string, currentNodeId: string) {
    super(
      `Task owned by another node: ${sessionId} owner=${ownerNodeId} current=${currentNodeId}`,
    );
    this.name = "TaskOwnedByAnotherNodeError";
  }
}
