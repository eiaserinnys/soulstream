import type { FastifyInstance } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { PersistentContextService } from "./persistent_context_service.js";

export const persistentContextRouteAuthRequirements = {
  "POST /api/persistent-context/host/evaluate": true,
} as const;

export type PersistentContextHostRouteOptions = {
  readonly service: PersistentContextService;
  readonly authBearerToken: string;
  readonly environment?: string;
};

export function registerPersistentContextHostRoutes(
  app: FastifyInstance,
  options: PersistentContextHostRouteOptions,
): void {
  app.post("/api/persistent-context/host/evaluate", async (request, reply) => {
    const receivedAt = Date.now();
    const authorization = verifyServiceBearerAuthorization(
      request.headers.authorization,
      options.authBearerToken,
      options.environment,
    );
    if (!authorization.ok) {
      return reply.code(authorization.statusCode).send({
        error: { code: "UNAUTHORIZED", message: `bearer token is ${authorization.reason}` },
      });
    }
    const input = readInput(request.body);
    if (input === null) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "invalid persistent context evaluation input" } });
    }

    const deadlineAt = receivedAt + input.budget_ms;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
    const onAborted = () => controller.abort();
    const onClosed = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", onAborted);
    reply.raw.once("close", onClosed);
    try {
      const result = await options.service.evaluatePersistentCandidates({
        sessionId: input.session_id,
        inputId: input.input_id,
        request: input.request,
        deadlineAt,
        signal: controller.signal,
      });
      return reply.type("application/json").send({ observation: Date.now() < deadlineAt ? result.observation : null });
    } catch {
      return reply.type("application/json").send({ observation: null });
    } finally {
      clearTimeout(deadlineTimer);
      request.raw.removeListener("aborted", onAborted);
      reply.raw.removeListener("close", onClosed);
    }
  });
}

function readInput(value: unknown): {
  session_id: string;
  input_id: string;
  request: string;
  budget_ms: number;
} | null {
  if (!isRecord(value) || !isRecord(value.args)) return null;
  const { session_id, input_id, request, budget_ms: budgetMs } = value.args;
  if (typeof session_id !== "string" || session_id.trim().length === 0
    || typeof input_id !== "string" || input_id.trim().length === 0
    || typeof request !== "string" || request.trim().length === 0
    || typeof budgetMs !== "number" || !Number.isInteger(budgetMs)
    || budgetMs <= 0 || budgetMs > 3_000) {
    return null;
  }
  return {
    session_id: session_id.trim(),
    input_id: input_id.trim(),
    request,
    budget_ms: budgetMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
