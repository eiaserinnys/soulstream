import type { FastifyReply } from "fastify";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
} from "../node/pending_commands.js";
import { NodeCommandTransportError } from "../session/session_command_transport.js";

export type ApiErrorPayload = {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
};

export type MappedNodeCommandError =
  | {
    readonly kind: "transport";
    readonly statusCode: 503;
    readonly apiError: ApiErrorPayload;
  }
  | {
    readonly kind: "timeout";
    readonly statusCode: 503;
    readonly apiError: ApiErrorPayload;
    readonly requestId: string;
  }
  | {
    readonly kind: "rejected";
    readonly statusCode: 503;
    readonly apiError: ApiErrorPayload;
    readonly requestId: string;
    readonly response: PendingNodeCommandRejectedError["response"];
  };

export function mapNodeCommandError(error: unknown): MappedNodeCommandError | undefined {
  if (error instanceof NodeCommandTransportError) {
    return {
      kind: "transport",
      statusCode: 503,
      apiError: {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId,
        connectionId: error.connectionId,
      },
    };
  }
  if (error instanceof PendingNodeCommandTimeoutError) {
    return {
      kind: "timeout",
      statusCode: 503,
      apiError: {
        code: "NODE_COMMAND_TIMEOUT",
        message: error.message,
        requestId: error.requestId,
      },
      requestId: error.requestId,
    };
  }
  if (error instanceof PendingNodeCommandRejectedError) {
    return {
      kind: "rejected",
      statusCode: 503,
      apiError: {
        code: "NODE_COMMAND_REJECTED",
        message: error.message,
      },
      requestId: error.requestId,
      response: error.response,
    };
  }
  return undefined;
}

export function apiErrorBody(error: ApiErrorPayload): { error: ApiErrorPayload } {
  return { error };
}

export function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  error: ApiErrorPayload,
  options: { envelope?: "error" | "detail" } = {},
): FastifyReply {
  const body = apiErrorBody(error);
  return reply.code(statusCode).send(
    options.envelope === "detail" ? { detail: body } : body,
  );
}
