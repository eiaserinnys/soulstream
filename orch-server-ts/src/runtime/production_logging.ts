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
  "secretAccessKey", "*.secretAccessKey", "req.body.secretAccessKey", "request.body.secretAccessKey", "body.secretAccessKey",
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
  "MCP_EXTERNAL_INGRESS_BEARER_TOKEN", "mcp_external_ingress_bearer_token",
  "jwtSecret",
  "jwt_secret",
  "databaseUrl",
  "database_url",
  "TURN_SUMMARY_OPENAI_KEY",
  "turn_summary_openai_key",
  "TYPESAFE_API_KEY",
  "typesafe_api_key",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.authBearerToken",
  "*.auth_bearer_token",
  "*.MCP_EXTERNAL_INGRESS_BEARER_TOKEN", "*.mcp_external_ingress_bearer_token",
  "*.jwtSecret",
  "*.jwt_secret",
  "*.databaseUrl",
  "*.database_url",
  "*.TURN_SUMMARY_OPENAI_KEY",
  "*.turn_summary_openai_key",
  "*.TYPESAFE_API_KEY",
  "*.typesafe_api_key",
] as const;

const HTTP_REQUEST_RECEIVE_TIMEOUT_MS = 300_000;

export function createOperationalFastifyOptions(
  config: OrchServerTsConfig,
  destination?: ProductionLogDestination,
): Pick<
  FastifyServerOptions,
  "disableRequestLogging" | "logger" | "requestTimeout" | "trustProxy"
> {
  const production = isProductionEnvironment(config.environment);
  return {
    disableRequestLogging: production,
    requestTimeout: HTTP_REQUEST_RECEIVE_TIMEOUT_MS,
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
      err: /^\/api\/admin\/settings\/(?:board|attachment)-r2(?:\/check)?$/.test(requestLogPath(request))
        ? { type: error.name, message: "Storage settings request failed" }
        : error,
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
