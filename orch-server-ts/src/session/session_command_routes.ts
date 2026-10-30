// Existing session route helpers remain together during parallel MCP extraction; the create-only response mapping is in session_create_route_response.ts. The create attachment admission step stays beside the create route it gates (#245).
import { isServiceCaller, type ServiceCaller } from "../auth/service_caller.js";
import { badRequest as createBadRequest, serviceUnavailable as createUnavailable, sendMappedError as createMappedError, sendCreateAckError as createAckError, type SessionCreateRouteResponse } from "./session_create_route_response.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { AdmittedAttachmentInput } from "../attachments/attachment_input_admission.js";
import { parseAttachmentIds, parseAttachmentPaths } from "./session_action_command_payloads.js";
import { isUuid } from "../http/uuid.js";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type RespondNodeCommandPayload,
} from "../node/pending_commands.js";
import type { CreateSessionNodeCommandPayload } from "../node/registry_types.js";
import { mapNodeCommandError, sendApiError } from "../http/api_errors.js";
import {
  ModelPresetAvailabilityError,
  type ModelPresetAvailabilityService,
} from "../model/model_preset_availability.js";
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

export type SessionCreateAttachmentAdmission = (
  caller: FastifyRequest | ServiceCaller,
  input: {
    sessionId: string;
    nodeId: string;
    attachmentIds?: string[];
    attachmentPaths?: string[];
  },
) => Promise<AdmittedAttachmentInput>;

export type SessionCommandRouteOptions = {
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  timeoutMs?: number;
  createSessionReconcileTimeoutMs?: number;
  createSessionLifecycle?: SessionCreateLifecycle;
  modelPresetAvailability?: Pick<ModelPresetAvailabilityService, "requireAvailable">;
  admitAttachmentInput?: SessionCreateAttachmentAdmission;
  worktreeAuthBearerToken?: string;
  environment?: string;
};

export const sessionCommandRouteAuthRequirements = {
  "POST /api/sessions": true,
  "POST /api/sessions/{session_id}/respond": true,
} as const;

/**
 * Create-path failures that are the caller's input problem, not the node being
 * unavailable. Anything absent from this table keeps the historical 503, so
 * timeouts, offline nodes and unknown internal failures retain their meaning.
 */
export const CREATE_ACK_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  UNSUPPORTED_REASONING_EFFORT: 422,
};

function createAckErrorStatus(code: unknown): number | undefined {
  // Own-property check: the code comes from a node, and a bare index would let
  // "toString" resolve to a function rather than falling through to 503.
  return typeof code === "string"
    && Object.hasOwn(CREATE_ACK_ERROR_HTTP_STATUS, code)
    ? CREATE_ACK_ERROR_HTTP_STATUS[code]
    : undefined;
}

/**
 * Sends a create-path node failure, preserving the node's own code and message.
 * Input errors become 4xx; everything else stays 503.
 */
function sendCreateAckError(
  reply: FastifyReply,
  response: { code?: unknown; message?: unknown },
): FastifyReply {
  const statusCode = createAckErrorStatus(response.code);
  if (statusCode === undefined) return serviceUnavailable(reply, response);
  return reply.code(statusCode).send({
    error: {
      code: response.code,
      message:
        typeof response.message === "string"
          ? response.message
          : "Session creation rejected",
    },
  });
}

const RESPOND_ACK_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_RUNNING: 409,
  REQUEST_NOT_PENDING: 422,
  INPUT_REQUEST_EXPIRED: 422,
  INPUT_REQUEST_ALREADY_RESPONDED: 422,
  INPUT_RESPONSE_NOT_SUPPORTED: 422,
};

type JsonObject = Record<string, unknown>;

const WAIT_FOR_INSTRUCTION_PROMPT =
  "업무 현황을 파악한 후, 사용자의 다음 지시를 대기해주세요.";
const EXECUTE_INSTRUCTION_PROMPT =
  "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.";

export function registerSessionCommandRoutes(
  app: FastifyInstance,
  options: SessionCommandRouteOptions,
): void {
  app.post("/api/sessions", async (request, reply) => {
    const result = await executeCreateSessionRoute(options, request, request.body, request.log);
    return reply.code(result.status).send(result.body);
  });

  app.post<{
    Params: { session_id: string };
  }>("/api/sessions/:session_id/respond", async (request, reply) => {
    const body = parseObjectBody(request.body);
    if (body === undefined) {
      return badRequest(reply, "Request body must be a JSON object");
    }
    const inputRequestId = Object.prototype.hasOwnProperty.call(body, "request_id")
      ? body.request_id
      : body.requestId;
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
      const routed = await options.router.respond(payload, {
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

/** Transport identity is preserved through the same preparation and node-command path. */
export async function executeCreateSessionRoute(
  options: SessionCommandRouteOptions,
  request: FastifyRequest | ServiceCaller,
  input: unknown,
  logger: Pick<import("fastify").FastifyRequest["log"], "warn">,
  reservedSessionId?: string,
): Promise<SessionCreateRouteResponse> {
    const body = parseObjectBody(input);
    if (body === undefined) {
      return createBadRequest("Request body must be a JSON object");
    }
    if (body.worktree_id !== undefined) {
      const authorization = isServiceCaller(request) ? { ok: true as const } : verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.worktreeAuthBearerToken ?? "",
        options.environment,
      );
      if (!authorization.ok) {
        return { status: authorization.statusCode, body: {
          error: {
            code: "WORKTREE_INTERNAL_AUTH_REQUIRED",
            message: `service bearer is ${authorization.reason}`,
          },
        } };
      }
      if (
        typeof body.worktree_actor_session_id !== "string"
        || body.worktree_actor_session_id.length === 0
      ) {
        return createBadRequest(
          "worktree_actor_session_id is required for worktree-bound sessions",
        );
      }
    }
    const attachmentPaths = parseAttachmentPaths(body);
    if (!attachmentPaths.ok) return createBadRequest(attachmentPaths.message);
    const attachmentIds = parseAttachmentIds(body);
    if (!attachmentIds.ok) return createBadRequest(attachmentIds.message);
    if (attachmentIds.value?.length && options.admitAttachmentInput === undefined) {
      return createUnavailable({
        code: "ATTACHMENT_INPUT_UNAVAILABLE",
        message: "Attachment input is unavailable",
      });
    }
    const resolvedPrompt = resolveCreateSessionPrompt(body);
    if ("error" in resolvedPrompt) return createBadRequest(resolvedPrompt.error);
    const { prompt } = resolvedPrompt;
    if (body.pageAnchor !== undefined && !isPageAnchor(body.pageAnchor)) {
      return createBadRequest("pageAnchor must include pageId, blockId, and a positive expectedVersion");
    }
    if (body.pageAnchor !== undefined && prompt.trim().length === 0) {
      return createBadRequest("prompt is required for page-anchored session creation");
    }
    if (
      body.predecessor_session_id !== undefined &&
      body.predecessor_session_id !== null &&
      (typeof body.predecessor_session_id !== "string" ||
        body.predecessor_session_id.trim().length === 0)
    ) {
      return createBadRequest("predecessor_session_id must be a non-empty string or null");
    }
    if (
      body.model_preset !== undefined
      && body.model_preset !== null
      && (
        typeof body.model_preset !== "string"
        || body.model_preset.trim().length === 0
      )
    ) {
      return createBadRequest("model_preset must be a non-empty string or null");
    }

    try {
      const prepared = await prepareCreateSession(options.createSessionLifecycle, request, body);
      const admission = await admitCreateAttachments(
        options,
        request,
        createSessionPayload(prepared.payload, prompt, reservedSessionId),
        attachmentIds.value,
      );
      if ("response" in admission) return admission.response;
      const payload = admission.payload;
      const routed = options.router.createSession(payload, {
        timeoutMs: options.timeoutMs,
        beforeCreateCommand: (selection) => {
          if (selection.modelPresetId && options.modelPresetAvailability) {
            options.modelPresetAvailability.requireAvailable(
              selection.node.nodeId,
              selection.modelPresetId,
            );
          }
        },
      });
      let result: NodeCommandResponse;
      try {
        result = await options.bridge.sendPendingCommand(routed);
      } catch (error) {
        if (error instanceof PendingNodeCommandTimeoutError) {
          try {
            const reconciled = await options.router.waitForCreatedSession(
              payload.agentSessionId,
              routed.node.nodeId,
              { timeoutMs: options.createSessionReconcileTimeoutMs },
            );
            if (reconciled) {
              logger.warn(
                {
                  requestId: error.requestId,
                  agentSessionId: payload.agentSessionId,
                  nodeId: routed.node.nodeId,
                },
                "create_session command timed out but the node session event was observed",
              );
              return { status: 201, body: {
                agentSessionId: payload.agentSessionId,
                nodeId: routed.node.nodeId,
                prompt,
              } };
            }
          } catch (reconcileError) {
            logger.warn(
              {
                err: reconcileError,
                requestId: error.requestId,
                agentSessionId: payload.agentSessionId,
                nodeId: routed.node.nodeId,
              },
              "create_session timeout reconciliation failed",
            );
          }
        }
        throw error;
      }
      if (isErrorAck(result)) {
        return createAckError(result);
      }
      const agentSessionId = payload.agentSessionId;
      if (
        typeof result.agentSessionId === "string" &&
        result.agentSessionId !== agentSessionId
      ) {
        return createUnavailable({
          code: "SESSION_ID_MISMATCH",
          message: "create_session ack changed the server-generated agentSessionId",
        });
      }
      return { status: 201, body: {
        agentSessionId,
        nodeId: routed.node.nodeId,
        prompt,
        ...(Array.isArray(result.warnings) ? { warnings: result.warnings } : {}),
      } };
    } catch (error) {
      return createMappedError(error);
    }
}

async function prepareCreateSession(
  lifecycle: SessionCreateLifecycle | undefined,
  request: Parameters<SessionCreateLifecycle["prepare"]>[0]["request"],
  body: JsonObject,
): Promise<PreparedSessionCreate> {
  if (lifecycle === undefined) return { payload: body };
  return lifecycle.prepare({ request, body });
}

/**
 * Pins the node the create will use, then admits the attachment ids and paths
 * against that node. The pinned nodeId/profile/model_preset keep router.createSession
 * from selecting a different node after admission. Without a callback or without
 * attachments the payload passes through untouched.
 */
async function admitCreateAttachments(
  options: SessionCommandRouteOptions,
  request: FastifyRequest | ServiceCaller,
  payload: CreateSessionNodeCommandPayload,
  attachmentIds: string[] | undefined,
): Promise<{ payload: CreateSessionNodeCommandPayload } | { response: SessionCreateRouteResponse }> {
  const admit = options.admitAttachmentInput;
  const attachmentPaths = payload.attachment_paths;
  if (admit === undefined || (!attachmentIds?.length && !attachmentPaths?.length)) {
    return { payload };
  }
  const selection = options.router.selectNodeForCreate({
    nodeId: firstNonEmptyString(payload.nodeId),
    profileId: firstNonEmptyString(payload.profile),
    modelPresetId: firstNonEmptyString(payload.model_preset),
    legacyModelSpecified: firstNonEmptyString(payload.model) !== undefined,
    worktreeRequired: firstNonEmptyString(payload.worktree_id) !== undefined,
  });
  let admitted: AdmittedAttachmentInput;
  try {
    admitted = await admit(request, {
      sessionId: payload.agentSessionId,
      nodeId: selection.node.nodeId,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(attachmentPaths?.length ? { attachmentPaths } : {}),
    });
  } catch (error) {
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (typeof code !== "string" || typeof statusCode !== "number") throw error;
    return { response: { status: statusCode, body: { error: {
      code, message: error instanceof Error ? error.message : code,
    } } } };
  }
  return { payload: {
    ...payload,
    nodeId: selection.node.nodeId,
    profile: selection.profileId,
    ...(selection.modelPresetId ? { model_preset: selection.modelPresetId } : {}),
    ...(admitted.attachment_ids.length > 0 ? { attachment_ids: admitted.attachment_ids } : {}),
    ...(admitted.attachment_bindings.length > 0 ? { attachment_bindings: admitted.attachment_bindings } : {}),
  } };
}

function createSessionPayload(
  body: JsonObject,
  prompt: string,
  reservedSessionId?: string,
): CreateSessionNodeCommandPayload {
  const {
    requestId: _requestId,
    fireAndForget: _fireAndForget,
    type: _type,
    initial_instruction: _initialInstruction,
    agentSessionId: requestedSessionId,
    agentId,
    profile,
    attachmentPaths: _attachmentPaths,
    attachment_paths: _attachmentPathsSnake,
    attachmentIds: _attachmentIds,
    attachment_ids: _attachmentIdsSnake,
    ...rest
  } = body;
  const agentSessionId = reservedSessionId ?? (isPageAnchor(rest.pageAnchor) && isUuid(requestedSessionId, 4)
    ? requestedSessionId
    : randomUUID());
  const canonicalProfile = firstNonEmptyString(profile, agentId);
  const attachments = parseAttachmentPaths(body);
  return {
    ...rest,
    ...(canonicalProfile === undefined ? {} : { profile: canonicalProfile }),
    type: "create_session",
    ...(attachments.ok && attachments.value?.length ? { attachment_paths: attachments.value } : {}),
    prompt,
    agentSessionId,
  };
}

function resolveCreateSessionPrompt(
  body: JsonObject,
): { prompt: string } | { error: string } {
  if (Object.prototype.hasOwnProperty.call(body, "initial_instruction")) {
    if (typeof body.initial_instruction !== "string") {
      return { error: "initial_instruction must be a string" };
    }
    const initialInstruction = body.initial_instruction.trim();
    return {
      prompt: initialInstruction.length === 0
        ? WAIT_FOR_INSTRUCTION_PROMPT
        : `${EXECUTE_INSTRUCTION_PROMPT}\n${initialInstruction}`,
    };
  }
  return typeof body.prompt === "string"
    ? { prompt: body.prompt }
    : { error: "prompt is required" };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function isPageAnchor(value: unknown): value is JsonObject {
  return isJsonObject(value)
    && typeof value.pageId === "string"
    && value.pageId.trim().length > 0
    && typeof value.blockId === "string"
    && value.blockId.trim().length > 0
    && Number.isInteger(value.expectedVersion)
    && Number(value.expectedVersion) > 0;
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
  return sendApiError(reply, 503, {
    code: typeof response.code === "string" ? response.code : "NODE_COMMAND_FAILED",
    message: typeof response.message === "string" ? response.message : "Node command failed",
  });
}

function sendMappedError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ModelPresetAvailabilityError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
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

  const nodeCommandError = mapNodeCommandError(error);
  if (nodeCommandError?.kind === "rejected") {
    // A rejection carrying a structured input-error code is the caller's
    // problem; without one it stays an upstream failure.
    return sendCreateAckError(reply, {
      code: nodeCommandError.response?.code ?? nodeCommandError.apiError.code,
      message: nodeCommandError.apiError.message,
    });
  }
  if (nodeCommandError !== undefined) {
    return sendApiError(reply, nodeCommandError.statusCode, nodeCommandError.apiError);
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
