import type { FastifyReply } from "fastify";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
} from "../node/pending_commands.js";
import {
  SessionCommandRouteError,
  type SessionCommandRouter,
} from "./session_command_router.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "./session_command_transport.js";
import type { SessionBackgroundSchedulePayload } from "./session_background_schedule_payloads.js";

export type SessionBackgroundScheduleCommandDispatchOptions = {
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  timeoutMs?: number;
};

export async function sendBackgroundScheduleCommand<
  TPayload extends SessionBackgroundSchedulePayload,
>(
  reply: FastifyReply,
  options: SessionBackgroundScheduleCommandDispatchOptions,
  payload: TPayload,
): Promise<FastifyReply | NodeCommandResponse> {
  try {
    const result = await dispatchBackgroundScheduleCommand(options, payload);
    if (isRuntimeCommandError(result)) {
      return sendClaudeRuntimeStatusError(reply, result);
    }
    return result;
  } catch (error) {
    return sendMappedBackgroundScheduleError(reply, error);
  }
}

export async function sendDeleteScheduleCommand(
  reply: FastifyReply,
  options: SessionBackgroundScheduleCommandDispatchOptions,
  payload: Extract<
    SessionBackgroundSchedulePayload,
    { type: "claude_runtime_delete_schedule" }
  >,
): Promise<FastifyReply | NodeCommandResponse> {
  try {
    const result = await dispatchBackgroundScheduleCommand(options, payload);
    if (isRuntimeCommandError(result)) {
      return sendClaudeRuntimeStatusError(reply, result);
    }
    if (result.status === "already_firing") {
      return reply.code(409).send(result);
    }
    return result;
  } catch (error) {
    return sendMappedBackgroundScheduleError(reply, error);
  }
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({
    error: {
      code: "INVALID_REQUEST",
      message,
    },
  });
}

async function dispatchBackgroundScheduleCommand<
  TPayload extends SessionBackgroundSchedulePayload,
>(
  options: SessionBackgroundScheduleCommandDispatchOptions,
  payload: TPayload,
): Promise<NodeCommandResponse> {
  const routed = options.router.routeExistingSessionPendingCommand(payload, {
    timeoutMs: options.timeoutMs,
  });
  return options.bridge.sendPendingCommand(routed);
}

function sendMappedBackgroundScheduleError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof PendingNodeCommandRejectedError) {
    const response = error.response;
    if (response !== undefined && isRuntimeCommandError(response)) {
      return sendClaudeRuntimeStatusError(reply, response);
    }
    return serviceUnavailable(reply, {
      code: "NODE_COMMAND_REJECTED",
      message: error.message,
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

  return reply.code(500).send({
    error: {
      code: "SESSION_BACKGROUND_SCHEDULE_COMMAND_ROUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function sendClaudeRuntimeStatusError(
  reply: FastifyReply,
  response: NodeCommandResponse,
): FastifyReply {
  const code = stringField(response.code, "CLAUDE_RUNTIME_COMMAND_FAILED");
  const message = stringField(response.message, code);
  return reply.code(claudeRuntimeStatusCode(code, message)).send({
    error: {
      code,
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
      code: stringField(response.code, "NODE_COMMAND_FAILED"),
      message: stringField(response.message, "Node command failed"),
    },
  });
}

function isRuntimeCommandError(response: NodeCommandResponse): boolean {
  return response.type === "error" || response.status === "error";
}

function claudeRuntimeStatusCode(code: string, message: string): number {
  const text = `${code} ${message}`.toLowerCase();
  if (text.includes("not_found") || text.includes("not found") || text.includes("찾을 수 없")) {
    return 404;
  }
  if (text.includes("not_supported") || text.includes("not supported") || text.includes("support")) {
    return 422;
  }
  return 422;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
