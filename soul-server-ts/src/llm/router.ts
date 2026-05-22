import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { ZodError } from "zod";

import { ProviderNotConfiguredError, type LlmExecutor } from "./executor.js";
import { parseLlmCompletionRequest } from "./types.js";

export interface LlmRouteConfig {
  executor: LlmExecutor;
  authBearerToken: string;
  isProduction: boolean;
  logger: Logger;
}

export function registerLlmRoutes(
  fastify: FastifyInstance,
  config: LlmRouteConfig,
): void {
  fastify.post("/llm/completions", async (request, reply) => {
    if (!verifyBearer(request, reply, config)) return;

    let body;
    try {
      body = parseLlmCompletionRequest(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(422).send({
          detail: err.issues.map((issue) => ({
            loc: issue.path,
            msg: issue.message,
            type: issue.code,
          })),
        });
      }
      throw err;
    }

    try {
      return await config.executor.execute(body);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        return reply.code(400).send({
          detail: {
            error: {
              code: "PROVIDER_NOT_CONFIGURED",
              message: err.message,
              details: {},
            },
          },
        });
      }

      config.logger.error({ err }, "LLM completion route failed");
      const message = config.isProduction
        ? "LLM API call failed"
        : `LLM API call failed: ${err instanceof Error ? err.message : String(err)}`;
      return reply.code(502).send({
        detail: {
          error: {
            code: "LLM_API_ERROR",
            message,
            details: {},
          },
        },
      });
    }
  });
}

function verifyBearer(
  request: FastifyRequest,
  reply: FastifyReply,
  config: LlmRouteConfig,
): boolean {
  const configuredToken = config.authBearerToken;
  if (!configuredToken) {
    if (config.isProduction) {
      reply.code(500).send({
        detail: {
          error: {
            code: "CONFIG_ERROR",
            message: "Authentication not configured",
            details: {},
          },
        },
      });
      return false;
    }
    return true;
  }

  const authorization = request.headers.authorization;
  if (!authorization) {
    reply.code(401).send({
      detail: {
        error: {
          code: "UNAUTHORIZED",
          message: "Authorization header is required",
          details: {},
        },
      },
    });
    return false;
  }

  const parts = authorization.split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    reply.code(401).send({
      detail: {
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid bearer token format",
          details: {},
        },
      },
    });
    return false;
  }

  if (!constantTimeEqual(parts[1] ?? "", configuredToken)) {
    reply.code(401).send({
      detail: {
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid token",
          details: {},
        },
      },
    });
    return false;
  }

  return true;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
