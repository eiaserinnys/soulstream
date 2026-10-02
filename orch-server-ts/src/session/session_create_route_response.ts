import { mapNodeCommandError } from "../http/api_errors.js";
import { ModelPresetAvailabilityError } from "../model/model_preset_availability.js";
import { SessionCommandRouteError } from "./session_command_router.js";
import { SessionCreateLifecycleError } from "./session_create_lifecycle.js";
import { SessionCreateNodeSelectionError } from "./session_create_node_selector.js";
import { CREATE_ACK_ERROR_HTTP_STATUS } from "./session_command_routes.js";

export type SessionCreateRouteResponse = { status: number; body: Record<string, unknown> };
export function badRequest(message: string): SessionCreateRouteResponse {
  return { status: 400, body: {
    error: {
      code: "INVALID_REQUEST",
      message,
    },
  } };
}

export function serviceUnavailable(
  response: { code?: unknown; message?: unknown },
): SessionCreateRouteResponse {
  return { status: 503, body: { error: {
    code: typeof response.code === "string" ? response.code : "NODE_COMMAND_FAILED",
    message: typeof response.message === "string" ? response.message : "Node command failed",
  } } };
}

export function sendMappedError(error: unknown): SessionCreateRouteResponse {
  if (error instanceof ModelPresetAvailabilityError) {
    return { status: error.statusCode, body: {
      error: {
        code: error.code,
        message: error.message,
      },
    } };
  }
  if (error instanceof SessionCreateNodeSelectionError) {
    return { status: error.statusCode, body: {
      error: {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId,
        profile: error.profileId,
        backend: error.backend,
      },
    } };
  }
  if (error instanceof SessionCreateLifecycleError) {
    return { status: error.statusCode, body: {
      error: {
        code: error.code,
        message: error.message,
      },
    } };
  }
  if (error instanceof SessionCommandRouteError) {
    if (error.code === "SESSION_OWNER_MISSING") {
      return { status: 404, body: {
        error: {
          code: error.code,
          message: error.message,
          agentSessionId: error.agentSessionId,
        },
      } };
    }
    return { status: 503, body: {
      error: {
        code: error.code,
        message: error.message,
        agentSessionId: error.agentSessionId,
        nodeId: error.nodeId,
      },
    } };
  }

  const nodeCommandError = mapNodeCommandError(error);
  if (nodeCommandError?.kind === "rejected") {
    // A rejection carrying a structured input-error code is the caller's
    // problem; without one it stays an upstream failure.
    return sendCreateAckError({
      code: nodeCommandError.response?.code ?? nodeCommandError.apiError.code,
      message: nodeCommandError.apiError.message,
    });
  }
  if (nodeCommandError !== undefined) {
    return { status: nodeCommandError.statusCode, body: { error: nodeCommandError.apiError } };
  }

  return { status: 500, body: {
    error: {
      code: "SESSION_COMMAND_ROUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  } };
}

export function sendCreateAckError(
  response: { code?: unknown; message?: unknown },
): SessionCreateRouteResponse {
  const statusCode = createAckErrorStatus(response.code);
  if (statusCode === undefined) return serviceUnavailable(response);
  return { status: statusCode, body: {
    error: {
      code: response.code,
      message:
        typeof response.message === "string"
          ? response.message
          : "Session creation rejected",
    },
  } };
}

export function createAckErrorStatus(code: unknown): number | undefined {
  // Own-property check: the code comes from a node, and a bare index would let
  // "toString" resolve to a function rather than falling through to 503.
  return typeof code === "string"
    && Object.hasOwn(CREATE_ACK_ERROR_HTTP_STATUS, code)
    ? CREATE_ACK_ERROR_HTTP_STATUS[code]
    : undefined;
}
