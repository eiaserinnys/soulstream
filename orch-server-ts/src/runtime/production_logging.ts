import { performance } from "node:perf_hooks";

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

import {
  DEFAULT_TRUSTED_PROXY,
  type OrchServerTsConfig,
} from "../config.js";

export type ProductionLogDestination = {
  write(message: string): void;
};

const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "token",
  "authBearerToken",
  "auth_bearer_token",
  "jwtSecret",
  "jwt_secret",
  "databaseUrl",
  "database_url",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.authBearerToken",
  "*.auth_bearer_token",
  "*.jwtSecret",
  "*.jwt_secret",
  "*.databaseUrl",
  "*.database_url",
] as const;

export function createOperationalFastifyOptions(
  config: OrchServerTsConfig,
  destination?: ProductionLogDestination,
): Pick<
  FastifyServerOptions,
  "disableRequestLogging" | "logger" | "trustProxy"
> {
  const production = isProductionEnvironment(config.environment);
  return {
    disableRequestLogging: production,
    logger: production
      ? {
          level: "info",
          redact: {
            paths: [...REDACTED_LOG_PATHS],
            censor: "[Redacted]",
          },
          ...(destination === undefined ? {} : { stream: destination }),
        }
      : false,
    trustProxy: config.trustProxy ?? DEFAULT_TRUSTED_PROXY,
  };
}

export function registerProductionLogging(
  app: FastifyInstance,
  environment: string,
): void {
  if (!isProductionEnvironment(environment)) return;
  const requestStartedAt = new WeakMap<FastifyRequest, number>();

  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, performance.now());
  });
  app.addHook("onError", async (request, reply, error) => {
    request.log.error({
      err: error,
      method: request.method,
      path: requestLogPath(request),
      statusCode: errorStatusCode(error, reply.statusCode),
      durationMs: durationMs(requestStartedAt.get(request)),
    }, "HTTP request failed");
  });
  app.addHook("onResponse", async (request, reply) => {
    const fields = {
      method: request.method,
      path: requestLogPath(request),
      statusCode: reply.statusCode,
      durationMs: durationMs(requestStartedAt.get(request)),
    };
    if (reply.statusCode === 401 || reply.statusCode === 403) {
      request.log.warn(fields, "HTTP request completed");
      return;
    }
    request.log.info(fields, "HTTP request completed");
  });
}

export function requestLogPath(request: FastifyRequest): string {
  return request.routeOptions.url || request.url.split("?", 1)[0] || "/";
}

function isProductionEnvironment(environment: string): boolean {
  return environment.toLowerCase() === "production";
}

function durationMs(startedAt: number | undefined): number {
  if (startedAt === undefined) return 0;
  return Number(Math.max(0, performance.now() - startedAt).toFixed(3));
}

function errorStatusCode(error: unknown, replyStatusCode: number): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400) return statusCode;
  }
  return replyStatusCode >= 400 ? replyStatusCode : 500;
}
