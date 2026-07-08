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
import type { ExistingSessionActionPayload } from "./session_action_command_payloads.js";

export type SessionActionCommandDispatchOptions = {
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  timeoutMs?: number;
};

export async function sendActionCommand<
  TPayload extends ExistingSessionActionPayload<string>,
>(
  reply: FastifyReply,
  options: SessionActionCommandDispatchOptions,
  payload: TPayload,
  ackErrorMapper: (reply: FastifyReply, response: NodeCommandResponse) => FastifyReply,
): Promise<FastifyReply | NodeCommandResponse> {
  try {
    const routed = options.router.routeExistingSessionPendingCommand(payload, {
      timeoutMs: options.timeoutMs,
    });
    const result = await options.bridge.sendPendingCommand(routed);
    if (isAckStatusError(result)) {
      return ackErrorMapper(reply, result);
    }
    return result;
  } catch (error) {
    return sendMappedActionError(reply, error, ackErrorMapper);
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

export function sendGenericStatusError(
  reply: FastifyReply,
  response: NodeCommandResponse,
): FastifyReply {
  return reply.code(422).send({
    error: {
      code: stringField(response.code, "NODE_COMMAND_FAILED"),
      message: stringField(response.message, "Node command failed"),
    },
  });
}

export function sendInterruptAckError(
  reply: FastifyReply,
  response: NodeCommandResponse,
): FastifyReply {
  const code = stringField(response.code, "INTERRUPT_SESSION_FAILED");
  return reply.code(interruptStatusCode(code, response.message)).send({
    error: {
      code,
      message: stringField(response.message, code),
    },
  });
}

export function sendToolApprovalAckError(
  reply: FastifyReply,
  response: NodeCommandResponse,
): FastifyReply {
  const code = stringField(response.code, "TOOL_APPROVAL_NOT_PENDING");
  return reply.code(toolApprovalStatusCode(code)).send({
    error: {
      code,
      message: stringField(response.message, code),
      approvalId: response.approvalId,
    },
  });
}

export function sendRealtimeAckError(
  reply: FastifyReply,
  response: NodeCommandResponse,
): FastifyReply {
  const code = stringField(response.code, "REALTIME_ERROR");
  return reply.code(422).send({
    error: {
      code,
      message: stringField(response.message, ""),
    },
  });
}

function isAckStatusError(response: NodeCommandResponse): boolean {
  return response.status === "error";
}

function sendMappedActionError(
  reply: FastifyReply,
  error: unknown,
  ackErrorMapper: (reply: FastifyReply, response: NodeCommandResponse) => FastifyReply,
): FastifyReply {
  if (error instanceof PendingNodeCommandRejectedError) {
    const response = error.response;
    if (response !== undefined && isAckStatusError(response)) {
      return ackErrorMapper(reply, response);
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
      code: "SESSION_ACTION_COMMAND_ROUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
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

function interruptStatusCode(code: string, message: unknown): number {
  const text = `${code} ${typeof message === "string" ? message : ""}`.toLowerCase();
  if (text.includes("not_found") || text.includes("not found")) return 404;
  if (text.includes("not_running") || text.includes("not running")) return 409;
  return 422;
}

function toolApprovalStatusCode(code: string): number {
  if (code === "SESSION_NOT_FOUND") return 404;
  if (code === "SESSION_NOT_RUNNING") return 409;
  return 422;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
