import type { FastifyInstance, FastifyReply } from "fastify";

import { mapNodeCommandError } from "../http/api_errors.js";
import {
  PersistentSessionApiError,
  type PersistentSessionSettingsService,
} from "./persistent_session_settings_service.js";
import { SessionCommandRouteError } from "./session_command_router.js";
import { SessionResourceAccessError } from "./session_resource_access.js";

export type PersistentSessionSettingsRouteOptions = {
  service: PersistentSessionSettingsService;
};

export const persistentSessionSettingsRouteAuthRequirements = {
  "GET /api/persistent-sessions": true,
  "GET /api/persistent-sessions/:session_id": true,
  "PUT /api/persistent-sessions/:session_id": true,
  "POST /api/persistent-sessions": true,
} as const;

/** Node-reported input failures that are the caller's problem rather than an unavailable node. */
const NODE_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  SESSION_NOT_FOUND: 404,
  NOT_PERSISTENT: 409,
  INVALID_REQUEST: 422,
  INVALID_MODEL_PRESET: 422,
  UNSUPPORTED_REASONING_EFFORT: 422,
};

export function registerPersistentSessionSettingsRoutes(
  app: FastifyInstance,
  options: PersistentSessionSettingsRouteOptions,
): void {
  const { service } = options;

  app.get("/api/persistent-sessions", async (request, reply) => {
    try {
      return reply.send(await service.list(request));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { session_id: string } }>("/api/persistent-sessions/:session_id", async (request, reply) => {
    try {
      return reply.send(await service.get(request, request.params.session_id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Params: { session_id: string } }>("/api/persistent-sessions/:session_id", async (request, reply) => {
    try {
      return reply.send(await service.update(request, request.params.session_id, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/persistent-sessions", async (request, reply) => {
    try {
      const result = await service.create(request, request.body, request.log);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PersistentSessionApiError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message },
      ...error.extra,
    });
  }
  if (error instanceof SessionResourceAccessError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof SessionCommandRouteError) {
    return reply.code(error.code === "SESSION_OWNER_MISSING" ? 404 : 503).send({
      error: { code: error.code, message: error.message },
    });
  }
  const nodeError = mapNodeCommandError(error);
  if (nodeError?.kind === "rejected") {
    const code = nodeError.response?.code;
    const status = typeof code === "string" && Object.hasOwn(NODE_ERROR_HTTP_STATUS, code)
      ? NODE_ERROR_HTTP_STATUS[code]
      : undefined;
    if (status !== undefined) {
      return reply.code(status).send({ error: { code, message: nodeError.apiError.message } });
    }
  }
  if (nodeError !== undefined) {
    return reply.code(nodeError.statusCode).send({ error: nodeError.apiError });
  }
  return reply.code(500).send({
    error: {
      code: "PERSISTENT_SESSION_ROUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
