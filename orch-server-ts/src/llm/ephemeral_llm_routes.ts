import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import {
  CODEX_REASONING_EFFORTS,
  CodexEphemeralExecutionError,
  type CodexEphemeralExecutor,
} from "./codex_ephemeral_executor.js";

export const EPHEMERAL_LLM_EXTERNAL_CONCURRENCY_LIMIT = 1;
export const EPHEMERAL_LLM_MAX_TIMEOUT_MS = 120_000;

export type EphemeralLlmRouteOptions = {
  readonly authBearerToken: string;
  readonly generator: Pick<CodexEphemeralExecutor, "generate">;
};

export const ephemeralLlmRouteAuthRequirements = {
  "POST /api/llm/ephemeral": true,
} as const;

const requestSchema = z.object({
  prompt: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoning_effort: z.enum(CODEX_REASONING_EFFORTS).default("medium"),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().positive().max(EPHEMERAL_LLM_MAX_TIMEOUT_MS)
    .default(EPHEMERAL_LLM_MAX_TIMEOUT_MS),
  max_attempts: z.number().int().min(1).max(3).default(1),
  purpose: z.string().trim().min(1).max(100).optional(),
}).strict();

export function registerEphemeralLlmRoutes(
  app: FastifyInstance,
  options: EphemeralLlmRouteOptions,
): void {
  app.post("/api/llm/ephemeral", async (request, reply) => {
    const authorization = verifyServiceBearerAuthorization(
      request.headers.authorization,
      options.authBearerToken,
    );
    if (!authorization.ok) {
      return errorReply(
        reply,
        401,
        "UNAUTHORIZED",
        `bearer token is ${authorization.reason}`,
      );
    }
    const parsed = requestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return errorReply(
        reply,
        422,
        "INVALID_EPHEMERAL_LLM_REQUEST",
        parsed.error.message,
      );
    }
    try {
      const result = await options.generator.generate({
        prompt: parsed.data.prompt,
        model: parsed.data.model,
        reasoningEffort: parsed.data.reasoning_effort,
        timeoutMs: parsed.data.timeout_ms,
        maxAttempts: parsed.data.max_attempts,
        concurrencyLimit: EPHEMERAL_LLM_EXTERNAL_CONCURRENCY_LIMIT,
        ...(parsed.data.output_schema === undefined
          ? {}
          : { outputSchema: parsed.data.output_schema }),
      });
      return reply.send({
        content: result.content,
        model: result.model,
        latency_ms: result.latencyMs,
        attempts: result.attempts,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
    } catch (error) {
      if (error instanceof CodexEphemeralExecutionError) {
        request.log.warn(
          {
            code: error.code,
            purpose: parsed.data.purpose,
            model: parsed.data.model,
            attempts: error.metrics.attempts,
            latencyMs: error.metrics.latencyMs,
          },
          "Ephemeral LLM request failed",
        );
        return errorReply(
          reply,
          statusForCode(error.code),
          error.code,
          error.message,
        );
      }
      request.log.error({ err: error }, "Ephemeral LLM route failed");
      return errorReply(
        reply,
        500,
        "EPHEMERAL_LLM_INTERNAL_ERROR",
        "Ephemeral LLM request failed",
      );
    }
  });
}

function statusForCode(code: CodexEphemeralExecutionError["code"]): number {
  if (code === "CODEX_UNAVAILABLE") return 503;
  if (code === "CODEX_TIMEOUT") return 504;
  return 502;
}

function errorReply(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}
