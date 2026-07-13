import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type RespondNodeCommandPayload,
} from "../node/pending_commands.js";
import type { CreateSessionNodeCommandPayload } from "../node/registry_types.js";
import { NodeCommandTransportError } from "./session_command_transport.js";
import {
  SessionCommandRouteError,
  SessionCommandRouter,
} from "./session_command_router.js";
import type { SessionCommandTransportBridge } from "./session_command_transport.js";
import {
  SessionCreateLifecycleError,
  type PreparedSessionCreate,
  type SessionCreateLifecycle,
} from "./session_create_lifecycle.js";
import { SessionCreateNodeSelectionError } from "./session_create_node_selector.js";

export type SessionCommandRouteOptions = {
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  timeoutMs?: number;
  createSessionLifecycle?: SessionCreateLifecycle;
};

export const sessionCommandRouteAuthRequirements = {
  "POST /api/sessions": true,
  "POST /api/sessions/{session_id}/respond": true,
} as const;

const RESPOND_ACK_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_RUNNING: 409,
  REQUEST_NOT_PENDING: 422,
  INPUT_REQUEST_EXPIRED: 422,
  INPUT_REQUEST_ALREADY_RESPONDED: 422,
  INPUT_RESPONSE_NOT_SUPPORTED: 422,
};

type JsonObject = Record<string, unknown>;

export function registerSessionCommandRoutes(
  app: FastifyInstance,
  options: SessionCommandRouteOptions,
): void {
  app.post("/api/sessions", async (request, reply) => {
    const body = parseObjectBody(request.body);
    if (body === undefined) {
      return badRequest(reply, "Request body must be a JSON object");
    }
    const prompt = body.prompt;
    if (typeof prompt !== "string") {
      return badRequest(reply, "prompt is required");
    }
    if (body.pageAnchor !== undefined && !isPageAnchor(body.pageAnchor)) {
      return badRequest(reply, "pageAnchor must include pageId, blockId, and a positive expectedVersion");
    }
    if (body.pageAnchor !== undefined && prompt.trim().length === 0) {
      return badRequest(reply, "prompt is required for page-anchored session creation");
    }

    try {
      const prepared = await prepareCreateSession(options.createSessionLifecycle, request, body);
      if (prepared.existingResponse !== undefined) {
        return reply.code(201).send(prepared.existingResponse);
      }
      const payload = createSessionPayload(prepared.payload, prompt);
      const routed = options.router.createSession(payload, {
        timeoutMs: options.timeoutMs,
      });
      const result = await options.bridge.sendPendingCommand(routed);
      if (isErrorAck(result)) {
        return serviceUnavailable(reply, result);
      }
      const agentSessionId = payload.agentSessionId;
      if (
        typeof result.agentSessionId === "string" &&
        result.agentSessionId !== agentSessionId
      ) {
        return serviceUnavailable(reply, {
          code: "SESSION_ID_MISMATCH",
          message: "create_session ack changed the server-generated agentSessionId",
        });
      }
      const taskFields = options.createSessionLifecycle === undefined
        ? {}
        : await options.createSessionLifecycle.complete({
            prepared,
            childSessionId: agentSessionId,
            childNodeId: routed.node.nodeId,
            prompt,
          });
      return reply.code(201).send({
        agentSessionId,
        nodeId: routed.node.nodeId,
        ...(Array.isArray(result.warnings) ? { warnings: result.warnings } : {}),
        ...taskFields,
      });
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post<{
    Params: { session_id: string };
  }>("/api/sessions/:session_id/respond", async (request, reply) => {
    const body = parseObjectBody(request.body);
    if (body === undefined) {
      return badRequest(reply, "Request body must be a JSON object");
    }
    const inputRequestId = body.request_id;
    if (typeof inputRequestId !== "string" || inputRequestId.length === 0) {
      return badRequest(reply, "request_id is required");
    }
    if (!isJsonObject(body.answers)) {
      return badRequest(reply, "answers must be a JSON object");
    }

    const payload: RespondNodeCommandPayload = {
      type: "respond",
      agentSessionId: request.params.session_id,
      inputRequestId,
      answers: body.answers,
    };
    try {
      const routed = options.router.respond(payload, {
        timeoutMs: options.timeoutMs,
      });
      const result = await options.bridge.sendPendingCommand(routed);
      if (isRespondAckError(result)) {
        return sendRespondAckError(reply, result);
      }
      return result;
    } catch (error) {
      if (error instanceof PendingNodeCommandRejectedError) {
        const response = error.response;
        if (response !== undefined && isRespondAckError(response)) {
          return sendRespondAckError(reply, response);
        }
      }
      return sendMappedError(reply, error);
    }
  });
}

async function prepareCreateSession(
  lifecycle: SessionCreateLifecycle | undefined,
  request: Parameters<SessionCreateLifecycle["prepare"]>[0]["request"],
  body: JsonObject,
): Promise<PreparedSessionCreate> {
  if (lifecycle === undefined) return { payload: body };
  return lifecycle.prepare({ request, body });
}

function createSessionPayload(
  body: JsonObject,
  prompt: string,
): CreateSessionNodeCommandPayload {
  const {
    requestId: _requestId,
    fireAndForget: _fireAndForget,
    type: _type,
    agentSessionId: requestedSessionId,
    ...rest
  } = body;
  const agentSessionId = isPageAnchor(rest.pageAnchor) && isUuid(requestedSessionId)
    ? requestedSessionId
    : randomUUID();
  return {
    ...rest,
    type: "create_session",
    prompt,
    agentSessionId,
  };
}

function isPageAnchor(value: unknown): value is JsonObject {
  return isJsonObject(value)
    && typeof value.pageId === "string"
    && typeof value.blockId === "string"
    && Number.isInteger(value.expectedVersion)
    && Number(value.expectedVersion) > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseObjectBody(body: unknown): JsonObject | undefined {
  return isJsonObject(body) ? body : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isErrorAck(response: NodeCommandResponse): boolean {
  return response.type === "error" || response.status === "error";
}

function isRespondAckError(response: NodeCommandResponse): boolean {
  return response.status === "error";
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({
    error: {
      code: "INVALID_REQUEST",
      message,
    },
  });
}

function serviceUnavailable(
  reply: FastifyReply,
  response: { code?: unknown; message?: unknown },
): FastifyReply {
  return reply.code(503).send({
    error: {
      code: typeof response.code === "string" ? response.code : "NODE_COMMAND_FAILED",
      message:
        typeof response.message === "string"
          ? response.message
          : "Node command failed",
    },
  });
}

function sendMappedError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SessionCreateNodeSelectionError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId,
        profile: error.profileId,
        backend: error.backend,
      },
    });
  }
  if (error instanceof SessionCreateLifecycleError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  if (error instanceof SessionCommandRouteError) {
    if (error.code === "SESSION_OWNER_MISSING") {
      return reply.code(404).send({
        error: {
          code: error.code,
          message: error.message,
          agentSessionId: error.agentSessionId,
        },
      });
    }
    return reply.code(503).send({
      error: {
        code: error.code,
        message: error.message,
        agentSessionId: error.agentSessionId,
        nodeId: error.nodeId,
      },
    });
  }

  if (error instanceof NodeCommandTransportError) {
    return reply.code(503).send({
      error: {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId,
        connectionId: error.connectionId,
      },
    });
  }

  if (error instanceof PendingNodeCommandTimeoutError) {
    return reply.code(503).send({
      error: {
        code: "NODE_COMMAND_TIMEOUT",
        message: error.message,
        requestId: error.requestId,
      },
    });
  }

  if (error instanceof PendingNodeCommandRejectedError) {
    return serviceUnavailable(reply, {
      code: "NODE_COMMAND_REJECTED",
      message: error.message,
    });
  }

  return reply.code(500).send({
    error: {
      code: "SESSION_COMMAND_ROUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function sendRespondAckError(
  reply: FastifyReply,
  result: NodeCommandResponse,
): FastifyReply {
  const code = typeof result.code === "string" ? result.code : "REQUEST_NOT_PENDING";
  const statusCode = RESPOND_ACK_ERROR_HTTP_STATUS[code] ?? 422;
  return reply.code(statusCode).send({
    error: {
      code,
      message: typeof result.message === "string" ? result.message : code,
      inputRequestId: result.inputRequestId,
    },
  });
}
