import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** The worker never exposed legacy reads; all former mutation routes are gone. */
export function registerTaskLegacyHttpCompatibility(
  fastify: FastifyInstance,
): void {
  const gone = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(410).send({
      detail: {
        error: {
          code: "RUNBOOK_MUTATION_REMOVED",
          message: "Runbook mutation routes were removed; use /api/tasks.",
        },
      },
    });

  fastify.post("/api/runbooks", gone);
  fastify.post("/api/runbooks/*", gone);
}
