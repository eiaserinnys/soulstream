import type { SessionMutationHost } from "../control_plane/persistence_host_clients.js";
import type { RegisterSessionParams, RegisterSessionReviewResult } from "../db/session_db_types.js";

export async function registerTaskSession(
  host: SessionMutationHost,
  registration: RegisterSessionParams,
  worktree: {
    worktreeId?: string;
    actorSessionId?: string;
    ownerTaskId: string | null;
  },
): Promise<RegisterSessionReviewResult | undefined> {
  if (!worktree.worktreeId) {
    return await host.registerSession(
      registration,
      `register_session:${registration.sessionId}`,
    );
  }
  const actorSessionId = worktree.actorSessionId?.trim();
  if (!actorSessionId) {
    throw new Error("worktreeActorSessionId is required when worktreeId is set");
  }
  return await host.registerSessionWithWorktree({
    ...registration,
    worktreeId: worktree.worktreeId,
    worktreeActorSessionId: actorSessionId,
    ownerTaskId: worktree.ownerTaskId,
  }, `register_session_with_worktree:${registration.sessionId}`);
}
