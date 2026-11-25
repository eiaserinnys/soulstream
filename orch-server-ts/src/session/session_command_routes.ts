import { isRecord } from "@soulstream/wire-schema/json-record";
import { EXECUTE_INSTRUCTION_PROMPT } from "@soulstream/wire-schema/conversation-visibility";
import { isServiceCaller, type ServiceCaller } from "../auth/service_caller.js";
import { sessionCreateBadRequest, serviceUnavailable, sendMappedError, sendCreateAckError, type SessionCreateRouteResponse } from "./session_create_route_response.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { NodeCredentialResolver } from "../node_credentials/types.js";
import type { AdmittedAttachmentInput } from "../attachments/attachment_input_admission.js";
import { parseObjectBody, type JsonObject } from "../http/route_validation.js";
import { parseAttachmentIds, parseAttachmentPaths } from "./session_action_command_payloads.js";
import { invalidRequest } from "./session_action_command_errors.js";
import { isUuid } from "../http/uuid.js";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type RespondNodeCommandPayload,
} from "../node/pending_commands.js";
import type { CreateSessionNodeCommandPayload } from "../node/registry_types.js";
import {
  type ModelPresetAvailabilityService,
} from "../model/model_preset_availability.js";
import {
  SessionCommandRouter,
  type SessionOwnerNodeIdLookup,
} from "./session_command_router.js";
import {
  requireRequestSessionAccess,
  type SessionRequestAccessGuard,
} from "./session_resource_access.js";
import type { SessionCommandTransportBridge } from "./session_command_transport.js";
import {
  type PreparedSessionCreate,
  type SessionCreateLifecycle,
} from "./session_create_lifecycle.js";

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
  /** One-shot durable owner lookup after a lost create ack (card #1326). */
  findSessionOwnerNodeId?: SessionOwnerNodeIdLookup;
  createSessionLifecycle?: SessionCreateLifecycle;
  modelPresetAvailability?: Pick<ModelPresetAvailabilityService, "requireAvailable">
    & Partial<Pick<ModelPresetAvailabilityService, "chooseUsablePreset">>;
  admitAttachmentInput?: SessionCreateAttachmentAdmission;
  worktreeAuthBearerToken?: string;
  environment?: string;
  nodeCredentials: NodeCredentialResolver | null;
  /** Session folder ACL for the HTTP handlers only (not `POST /api/sessions`). */
  accessProvider?: SessionRequestAccessGuard;
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

const WAIT_FOR_INSTRUCTION_PROMPT =
  "업무 현황을 파악한 후, 사용자의 다음 지시를 대기해주세요.";

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
    const denied = await requireRequestSessionAccess(
      options.accessProvider,
      request,
      reply,
      request.params.session_id,
    );
    if (denied) return reply;
    const parsedBody = parseObjectBody(request.body);
    if (!parsedBody.ok) {
      return invalidRequest(reply, parsedBody.message);
    }
    const body = parsedBody.value;
    const inputRequestId = Object.prototype.hasOwnProperty.call(body, "request_id")
      ? body.request_id
      : body.requestId;
    if (typeof inputRequestId !== "string" || inputRequestId.length === 0) {
      return invalidRequest(reply, "request_id is required");
    }
    if (!isRecord(body.answers)) {
      return invalidRequest(reply, "answers must be a JSON object");
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
      const mapped = sendMappedError(error);
      return reply.code(mapped.status).send(mapped.body);
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
    const parsedBody = parseObjectBody(input);
    if (!parsedBody.ok) {
      return sessionCreateBadRequest(parsedBody.message);
    }
    const body = parsedBody.value;
    if (body.worktree_id !== undefined) {
      const authorization = isServiceCaller(request) ? { ok: true as const } : verifyServiceBearerAuthorization(
        request.headers.authorization,
        {
          configuredToken: options.worktreeAuthBearerToken ?? "",
          environment: options.environment,
          nodeCredentials: options.nodeCredentials,
        },
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
        return sessionCreateBadRequest(
          "worktree_actor_session_id is required for worktree-bound sessions",
        );
      }
    }
    const attachmentPaths = parseAttachmentPaths(body);
    if (!attachmentPaths.ok) return sessionCreateBadRequest(attachmentPaths.message);
    const attachmentIds = parseAttachmentIds(body);
    if (!attachmentIds.ok) return sessionCreateBadRequest(attachmentIds.message);
    if (attachmentIds.value?.length && options.admitAttachmentInput === undefined) {
      return serviceUnavailable({
        code: "ATTACHMENT_INPUT_UNAVAILABLE",
        message: "Attachment input is unavailable",
      });
    }
    const resolvedPrompt = resolveCreateSessionPrompt(body);
    if ("error" in resolvedPrompt) return sessionCreateBadRequest(resolvedPrompt.error);
    const { prompt } = resolvedPrompt;
    if (body.pageAnchor !== undefined && !isPageAnchor(body.pageAnchor)) {
      return sessionCreateBadRequest("pageAnchor must include pageId, blockId, and a positive expectedVersion");
    }
    if (body.pageAnchor !== undefined && prompt.trim().length === 0) {
      return sessionCreateBadRequest("prompt is required for page-anchored session creation");
    }
    if (
      body.predecessor_session_id !== undefined &&
      body.predecessor_session_id !== null &&
      (typeof body.predecessor_session_id !== "string" ||
        body.predecessor_session_id.trim().length === 0)
    ) {
      return sessionCreateBadRequest("predecessor_session_id must be a non-empty string or null");
    }
    if (
      body.model_preset !== undefined
      && body.model_preset !== null
      && (
        typeof body.model_preset !== "string"
        || body.model_preset.trim().length === 0
      )
    ) {
      return sessionCreateBadRequest("model_preset must be a non-empty string or null");
    }
    if (body.model_preset_fallbacks !== undefined) {
      const fallbacks = body.model_preset_fallbacks;
      if (
        !Array.isArray(fallbacks)
        || fallbacks.some((item) => typeof item !== "string")
      ) {
        return sessionCreateBadRequest("model_preset_fallbacks must be a string array");
      }
      if (fallbacks.some((item) => (item as string).trim().length === 0)) {
        return sessionCreateBadRequest("model_preset_fallbacks must contain non-blank strings");
      }
    }

    try {
      await options.router.waitForNode(firstNonEmptyString(body.node_id, body.nodeId));
      const prepared = await prepareCreateSession(options.createSessionLifecycle, request, body);
      const admission = await admitCreateAttachments(
        options,
        request,
        createSessionPayload(prepared.payload, prompt, reservedSessionId),
        attachmentIds.value,
      );
      if ("response" in admission) return admission.response;
      const payload = applyModelPresetFallbacks(options, admission.payload);
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
        const outcome = await observeCreateAckLoss(
          options,
          logger,
          error,
          payload.agentSessionId,
          routed.node.nodeId,
        );
        if (outcome === "created") {
          return { status: 201, body: {
            agentSessionId: payload.agentSessionId,
            nodeId: routed.node.nodeId,
            prompt,
          } };
        }
        if (outcome === "not_created" || outcome === "unknown") {
          return withCreateOutcome(
            sendMappedError(error),
            payload.agentSessionId,
            outcome,
          );
        }
        throw error;
      }
      if (isErrorAck(result)) {
        return sendCreateAckError(result);
      }
      const agentSessionId = payload.agentSessionId;
      if (
        typeof result.agentSessionId === "string" &&
        result.agentSessionId !== agentSessionId
      ) {
        return serviceUnavailable({
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
      return sendMappedError(error);
    }
}

type CreateAckLossOutcome =
  | "created"
  | "not_created"
  | "unknown"
  | "not_applicable";

/**
 * A create whose ack never reached us (node command timeout, or a disconnect
 * rejecting the pending command) may still have created the session on the
 * node. Reuse the existing reconcile wait, then read the durable session row
 * once so the caller receives an outcome instead of having to poll
 * list_sessions (card #1326).
 */
async function observeCreateAckLoss(
  options: SessionCommandRouteOptions,
  logger: Pick<import("fastify").FastifyRequest["log"], "warn">,
  error: unknown,
  agentSessionId: string,
  nodeId: string,
): Promise<CreateAckLossOutcome> {
  const timeoutError =
    error instanceof PendingNodeCommandTimeoutError ? error : undefined;
  const disconnectError = isDisconnectRejection(error) ? error : undefined;
  if (timeoutError === undefined && disconnectError === undefined) {
    return "not_applicable";
  }
  const requestId = timeoutError?.requestId ?? disconnectError?.requestId;

  try {
    const reconciled = await options.router.waitForCreatedSession(
      agentSessionId,
      nodeId,
      { timeoutMs: options.createSessionReconcileTimeoutMs },
    );
    if (reconciled) {
      logger.warn(
        { requestId, agentSessionId, nodeId },
        "create_session command timed out but the node session event was observed",
      );
      return "created";
    }
  } catch (reconcileError) {
    logger.warn(
      { err: reconcileError, requestId, agentSessionId, nodeId },
      "create_session timeout reconciliation failed",
    );
  }

  const findOwner = options.findSessionOwnerNodeId;
  if (findOwner === undefined) return "unknown";
  try {
    const ownerNodeId = await findOwner(agentSessionId);
    if (ownerNodeId === nodeId) {
      logger.warn(
        { requestId, agentSessionId, nodeId },
        "create_session command timed out but the durable session row belongs to the node",
      );
      return "created";
    }
    // A row owned by another node leaves this node's create unconfirmed.
    return ownerNodeId === null ? "not_created" : "unknown";
  } catch (lookupError) {
    logger.warn(
      { err: lookupError, requestId, agentSessionId, nodeId },
      "create_session outcome lookup failed",
    );
    return "unknown";
  }
}

/** A disconnect rejects pending commands without a node response (registry.rejectAll). */
function isDisconnectRejection(
  error: unknown,
): error is PendingNodeCommandRejectedError {
  return (
    error instanceof PendingNodeCommandRejectedError
    && error.response === undefined
  );
}

function withCreateOutcome(
  response: SessionCreateRouteResponse,
  agentSessionId: string,
  outcome: "not_created" | "unknown",
): SessionCreateRouteResponse {
  const error = response.body.error;
  if (!isRecord(error)) return response;
  return {
    status: response.status,
    body: {
      ...response.body,
      error: {
        ...error,
        agentSessionId,
        ...(outcome === "not_created" ? { created: false } : {}),
      },
    },
  };
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

/**
 * Declared fallback order: after node/profile admission, choose the first usable
 * candidate inside the selected node and pin that selection in the payload. The
 * router re-derives its selection from this payload, so the chosen preset is
 * what the node receives. A requested reasoning effort is discarded when the
 * chosen preset differs from the declared primary.
 */
function applyModelPresetFallbacks(
  options: SessionCommandRouteOptions,
  payload: CreateSessionNodeCommandPayload,
): CreateSessionNodeCommandPayload {
  const fallbacks = payload.model_preset_fallbacks;
  if (fallbacks !== undefined && Array.isArray(fallbacks) && fallbacks.length === 0) {
    // 빈 목록은 기능 미사용 — 선언 필드 없이 이전과 같은 명령을 보낸다.
    const { model_preset_fallbacks: _empty, ...rest } = payload;
    return rest;
  }
  const availability = options.modelPresetAvailability;
  if (availability?.chooseUsablePreset === undefined || !Array.isArray(fallbacks)) {
    return payload;
  }
  const selection = options.router.selectNodeForCreate({
    nodeId: firstNonEmptyString(payload.nodeId),
    profileId: firstNonEmptyString(payload.profile),
    modelPresetId: firstNonEmptyString(payload.model_preset),
    legacyModelSpecified: firstNonEmptyString(payload.model) !== undefined,
    worktreeRequired: firstNonEmptyString(payload.worktree_id) !== undefined,
  });
  const initialModelPreset = selection.modelPresetId;
  if (initialModelPreset === undefined) return payload;
  // Call through the service: its method reads node availability via `this`.
  const chosenPresetId = availability.chooseUsablePreset(
    selection.node.nodeId,
    [initialModelPreset, ...fallbacks],
  );
  const { reasoningEffort, ...rest } = payload;
  return {
    ...rest,
    nodeId: selection.node.nodeId,
    profile: selection.profileId,
    model_preset: chosenPresetId,
    initial_model_preset: initialModelPreset,
    model_preset_fallbacks: fallbacks,
    ...(chosenPresetId === initialModelPreset && reasoningEffort !== undefined
      ? { reasoningEffort }
      : {}),
  };
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
  return isRecord(value)
    && typeof value.pageId === "string"
    && value.pageId.trim().length > 0
    && typeof value.blockId === "string"
    && value.blockId.trim().length > 0
    && Number.isInteger(value.expectedVersion)
    && Number(value.expectedVersion) > 0;
}

function isErrorAck(response: NodeCommandResponse): boolean {
  return response.type === "error" || response.status === "error";
}

function isRespondAckError(response: NodeCommandResponse): boolean {
  return response.status === "error";
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
