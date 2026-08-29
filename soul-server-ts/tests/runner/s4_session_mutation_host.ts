import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
import type { SessionMutationHost } from
  "../../src/control_plane/persistence_host_clients.js";
import type { SqlClient } from "../../src/db/session_db.js";

/** Keeps the production repository behind the worker's persistence-host port. */
export function createS4SessionMutationHost(sql: SqlClient): SessionMutationHost {
  const repository = new SessionMutationRepository(sql as never);
  return {
    registerSession: async (input, idempotencyKey) => {
      await repository.registerSession({ ...input, idempotencyKey });
    },
    transitionSession: async (sessionId, fields, idempotencyKey, updatedAt = new Date()) => {
      await repository.transitionSession({
        sessionId,
        idempotencyKey,
        updatedAt,
        fields: {
          ...fields,
          clientId: fields.client_id,
          wasRunningAtShutdown: fields.was_running_at_shutdown,
          lastReadEventId: fields.last_read_event_id,
          terminationReason: fields.termination_reason,
          terminationDetail: fields.termination_detail,
          reviewState: fields.review_state,
        },
      });
    },
    renameSession: async (sessionId, displayName, idempotencyKey) => {
      await repository.renameSession({ sessionId, displayName, idempotencyKey });
    },
    deleteSession: async () => {
      throw new Error("S4 delete_session is not part of the flow");
    },
    acknowledgeReview: async (sessionId, idempotencyKey, updatedAt = new Date()) =>
      await repository.acknowledgeReview({ sessionId, idempotencyKey, updatedAt }) as never,
  };
}
