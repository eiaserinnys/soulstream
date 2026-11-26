import { performance } from "node:perf_hooks";

import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

import {
  DEFAULT_TRUSTED_PROXY,
  type OrchServerTsConfig,
} from "../config.js";
import {
  hostRequestLogLevel,
  isHostRequestPath,
} from "../control_plane/host_request_log_level.js";
import {
  externalAccessLogPath,
  isExternalAccessRequestPath,
} from "../external_access/external_access_paths.js";

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
const authenticatedNodeIds = new WeakMap<FastifyRequest, string>();

export function setAuthenticatedLogNodeId(request: FastifyRequest, nodeId: string): void {
  authenticatedNodeIds.set(request, nodeId);
}

export function createOperationalFastifyOptions(
  config: OrchServerTsConfig,
  destination?: ProductionLogDestination,
): Pick<
  FastifyServerOptions,
  "disableRequestLogging" | "frameworkErrors" | "logger" | "requestTimeout" | "trustProxy"
> {
  const production = isProductionEnvironment(config.environment);
  return {
    disableRequestLogging: production,
    frameworkErrors: frameworkErrorResponse,
    requestTimeout: HTTP_REQUEST_RECEIVE_TIMEOUT_MS,
    logger: production
      ? {
          level: "info",
          redact: {
            paths: [...REDACTED_LOG_PATHS],
            censor: "[Redacted]",
          },
          // Any log that carries `req` goes through this serializer, so a
          // request path that contains an access link key is redacted even
          // when the error handler or another component logs the request.
          serializers: {
            req: (request: FastifyRequest) => ({
              method: request.method,
              url: serializedRequestUrl(request),
              hostname: request.hostname,
              remoteAddress: request.ip,
            }),
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
    if (isExternalAccessRequestPath(requestUrlPath(request))) {
      request.log.error({
        errorCode: errorCode(error),
        method: request.method,
        path: requestLogPath(request),
        statusCode: errorStatusCode(error, reply.statusCode),
        durationMs: durationMs(requestStartedAt.get(request)),
      }, "HTTP request failed");
      return;
    }
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
    const header = request.headers["x-soulstream-node-id"];
    const nodeId = authenticatedNodeIds.get(request) ?? (Array.isArray(header) ? header[0] : header);
    const fields = {
      method: request.method,
      path: requestLogPath(request),
      statusCode: reply.statusCode,
      durationMs: durationMs(requestStartedAt.get(request)),
      ...(nodeId ? { nodeId } : {}),
    };
    if (reply.statusCode === 401 || reply.statusCode === 403) {
      request.log.warn(fields, "HTTP request completed");
      return;
    }
    const level = isHostRequestPath(fields.path)
      ? hostRequestLogLevel(fields.statusCode, fields.durationMs)
      : "info";
    request.log[level](fields, "HTTP request completed");
  });
}

export function requestLogPath(request: FastifyRequest): string {
  const path = requestUrlPath(request);
  if (isExternalAccessRequestPath(path)) {
    return externalAccessLogPath(request.routeOptions.url);
  }
  return request.routeOptions.url || path;
}

function requestUrlPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] || "/";
}

/** `req.url` for log serialization: `/x` keeps the query out, others as-is. */
function serializedRequestUrl(request: FastifyRequest): string {
  const rawUrl = request.raw?.url ?? request.url ?? "";
  const path = rawUrl.split("?", 1)[0] || "/";
  if (isExternalAccessRequestPath(path)) {
    const routeTemplate = (request as {
      readonly routeOptions?: { readonly url?: string };
    }).routeOptions?.url;
    return externalAccessLogPath(routeTemplate);
  }
  return rawUrl;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Fastify's built-in bad-URL/async-constraint responses write the raw path
 * into the body without going through any route, which would print an access
 * link key. The default answer is reproduced for other paths.
 */
function frameworkErrorResponse(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const path = request.url.split("?", 1)[0] || "/";
  if (isExternalAccessRequestPath(path)) {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.code(400).send({ error: { code: "invalid_request", message: "Invalid request" } });
    return;
  }
  if (error.code === "FST_ERR_BAD_URL") {
    reply.code(400).send({
      error: "Bad Request",
      code: error.code,
      message: error.message,
      statusCode: 400,
    });
    return;
  }
  reply.code(500).send({
    error: "Internal Server Error",
    message: "Unexpected error from async constraint",
    statusCode: 500,
  });
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
