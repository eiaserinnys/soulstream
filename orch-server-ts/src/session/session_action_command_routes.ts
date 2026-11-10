import type { ServiceCaller } from "../auth/service_caller.js";
import { createHash, randomUUID } from "node:crypto";

import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";
import { buildCanonicalDeliveryPayload } from "@soulstream/wire-schema/delivery";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MESSAGE_BODY_LIMIT } from "../conversation/conversation_messages.js";

import type { SessionDeliveryRepository } from
  "../control_plane/repositories/session_delivery_repository.js";

import {
  badRequest,
  sendActionCommand,
  sendGenericStatusError,
  executeInterveneCommand,
  type SessionActionResponse,
  sendInterruptAckError,
  sendReviewAcknowledgeCommand,
  sendRealtimeAckError,
  sendToolApprovalAckError,
  type SessionActionCommandDispatchOptions,
} from "./session_action_command_errors.js";
import {
  intervenePayload,
  parseObjectBody,
  realtimeCreateCallPayload,
  realtimeEventPayload,
  realtimeResolveToolApprovalPayload,
  toolApprovalPayload,
  type ApprovalParams,
  type InlineAttachmentUpload,
  type InterveneNodeCommandPayload,
  type InterruptNodeCommandPayload,
  type JsonObject,
  type AcknowledgeSessionReviewNodeCommandPayload,
  type SessionParams,
} from "./session_action_command_payloads.js";
import type { SessionReviewAcknowledgeFallback } from "./session_review_acknowledge_fallback.js";

export type SessionActionCallerInfoResolver = (
  request: FastifyRequest | ServiceCaller,
  bodyCallerInfo: JsonObject | undefined,
  targetSessionId: string,
) => Promise<JsonObject> | JsonObject;

export type SessionActionAttachmentAdmission = (
  caller: FastifyRequest | ServiceCaller,
  input: {
    sessionId: string;
    attachmentIds?: string[];
    attachmentPaths?: string[];
  },
) => Promise<{
  attachment_ids: string[];
  attachment_paths: string[];
  attachment_bindings: AttachmentPathBinding[];
}>;

export type SessionActionInlineAttachmentUpload = (
  caller: FastifyRequest | ServiceCaller,
  sessionId: string,
  file: InlineAttachmentUpload,
  uploadId: string,
) => Promise<{ path: string; name: string; mime: string; assetId?: string }>;

export type SessionActionCommandRouteOptions =
  SessionActionCommandDispatchOptions & {
    resolveCallerInfo?: SessionActionCallerInfoResolver;
    admitAttachmentInput?: SessionActionAttachmentAdmission;
    uploadInlineAttachment?: SessionActionInlineAttachmentUpload;
    reviewAcknowledgeFallback?: SessionReviewAcknowledgeFallback;
    deliveryRepositoryProvider?: () => Promise<Pick<SessionDeliveryRepository, "register">>;
    /**
     * 판 답을 처리한 뒤 결과를 알린다. handled면 intervene를 더 진행하지 않고 카드 질문 답 ACK를 돌려주고,
     * failure면 그 오류를 그대로 응답한다. undefined/void면 지금까지처럼 본문 전달로 이어진다.
     */
    acceptPersistentReportReply?: (sessionId: string, context: unknown, callerInfo: JsonObject | undefined, request: FastifyRequest | ServiceCaller) =>
      Promise<{ handled: boolean; failure?: { status: number; body: unknown } } | undefined>;
    onHumanSessionInput?: (targetSessionId: string) => Promise<void>;
  };

export const sessionActionCommandRouteAuthRequirements = {
  "POST /api/sessions/:session_id/intervene": true,
  "POST /api/sessions/:session_id/message": true,
  "POST /api/sessions/:session_id/interrupt": true,
  "POST /api/sessions/:session_id/review/acknowledge": true,
  "POST /api/sessions/:session_id/tool-approvals/:approval_id/approve": true,
  "POST /api/sessions/:session_id/tool-approvals/:approval_id/reject": true,
  "POST /api/sessions/:session_id/realtime/call": true,
  "POST /api/sessions/:session_id/realtime/events": true,
  "POST /api/sessions/:session_id/realtime/tool-approvals/:approval_id/resolve": true,
} as const;

export function registerSessionActionCommandRoutes(
  app: FastifyInstance,
  options: SessionActionCommandRouteOptions,
): void {
  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/intervene",
    { bodyLimit: MESSAGE_BODY_LIMIT },
    async (request, reply) => {
      const result = await executeSessionIntervention(options, request, sessionParams(request).session_id, request.body);
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/review/acknowledge",
    async (request, reply) => {
      const payload: AcknowledgeSessionReviewNodeCommandPayload = {
        type: "acknowledge_session_review",
        agentSessionId: sessionParams(request).session_id,
      };
      return sendReviewAcknowledgeCommand(reply, options, payload);
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/message",
    async (request, reply) => deprecatedSessionMessage(reply, sessionParams(request).session_id),
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/interrupt",
    async (request, reply) => {
      const payload: InterruptNodeCommandPayload = {
        type: "interrupt_session",
        agentSessionId: sessionParams(request).session_id,
      };
      return sendActionCommand(reply, options, payload, sendInterruptAckError);
    },
  );

  app.post<{ Params: ApprovalParams }>(
    "/api/sessions/:session_id/tool-approvals/:approval_id/approve",
    async (request, reply) => {
      const payload = toolApprovalPayload(
        approvalParams(request),
        request.body,
        "approve_tool",
      );
      if (!payload.ok) return badRequest(reply, payload.message);
      return sendActionCommand(reply, options, payload.value, sendToolApprovalAckError);
    },
  );

  app.post<{ Params: ApprovalParams }>(
    "/api/sessions/:session_id/tool-approvals/:approval_id/reject",
    async (request, reply) => {
      const payload = toolApprovalPayload(
        approvalParams(request),
        request.body,
        "reject_tool",
      );
      if (!payload.ok) return badRequest(reply, payload.message);
      return sendActionCommand(reply, options, payload.value, sendToolApprovalAckError);
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/realtime/call",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (body === undefined) {
        return badRequest(reply, "Request body must be a JSON object");
      }

      const payload = realtimeCreateCallPayload(sessionParams(request).session_id, body);
      if (!payload.ok) return badRequest(reply, payload.message);

      return sendActionCommand(reply, options, payload.value, sendRealtimeAckError);
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/realtime/events",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (body === undefined) {
        return badRequest(reply, "Request body must be a JSON object");
      }

      const payload = realtimeEventPayload(sessionParams(request).session_id, body);
      if (!payload.ok) return badRequest(reply, payload.message);

      return sendActionCommand(reply, options, payload.value, sendRealtimeAckError);
    },
  );

  app.post<{ Params: ApprovalParams }>(
    "/api/sessions/:session_id/realtime/tool-approvals/:approval_id/resolve",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (body === undefined) {
        return badRequest(reply, "Request body must be a JSON object");
      }

      const payload = realtimeResolveToolApprovalPayload(
        approvalParams(request),
        body,
      );
      if (!payload.ok) return badRequest(reply, payload.message);

      return sendActionCommand(reply, options, payload.value, sendRealtimeAckError);
    },
  );
}

/** Shared body of the HTTP intervention route and orchestrator MCP message tool. */
export async function executeSessionIntervention(
  options: SessionActionCommandRouteOptions,
  caller: FastifyRequest | ServiceCaller,
  targetSessionId: string,
  input: unknown,
): Promise<SessionActionResponse> {
  const body = parseObjectBody(input);
  if (body === undefined) return { status: 400, body: { error: { code: "INVALID_REQUEST", message: "Request body must be a JSON object" } } };
  const payload = intervenePayload(targetSessionId, body);
  if (!payload.ok) return { status: 400, body: { error: { code: "INVALID_REQUEST", message: payload.message } } };
  if (options.resolveCallerInfo !== undefined) {
    payload.value.caller_info = await options.resolveCallerInfo(caller, payload.value.caller_info, targetSessionId);
  }
  // 카드 질문 장에 대한 답이면 본문을 담당 세션으로 보내지 않고 카드 답으로 접수한다. 첨부 수락과 durable 등록보다 먼저 끝낸다.
  if (options.acceptPersistentReportReply !== undefined) {
    let reply: { handled: boolean; failure?: { status: number; body: unknown } } | undefined;
    try {
      reply = await options.acceptPersistentReportReply(targetSessionId, payload.value.extra_context_items, payload.value.caller_info, caller);
    } catch (error) {
      if ("log" in caller) caller.log.warn({ err: error }, "Report answer update failed; delivering the user message");
    }
    if (reply?.failure) return { status: reply.failure.status, body: reply.failure.body };
    if (reply?.handled) return cardQuestionAnsweredResponse(targetSessionId);
  }
  const admitted = await admitAttachmentInput(options, caller, payload.value);
  if ("response" in admitted) return admitted.response;
  const durable = await admitDurableHumanIntervention(options, admitted.payload);
  if (durable.conflict) return { status: 409, body: { error: {
    code: "DELIVERY_IDENTITY_CONFLICT", message: `Delivery identity conflict: ${durable.deliveryId}`, deliveryId: durable.deliveryId,
  } } };
  const response=await executeInterveneCommand(options, durable.payload, durable.deliveryId);
  if (response.status>=200 && response.status<300 && "log" in caller
    && (payload.value.caller_info?.source==="browser" || payload.value.caller_info?.source==="soul-app")
    && options.onHumanSessionInput) {
    try { await options.onHumanSessionInput(targetSessionId); }
    catch (error) { caller.log.warn({err:error,targetSessionId},"Card resume after human session input failed"); }
  }
  return response;
}

/** 카드 질문에 판에서 답한 경우. 담당 세션에는 보내지 않았지만 사용자 답변은 기록되었으니 전달 완료로 알린다. */
function cardQuestionAnsweredResponse(agentSessionId: string): SessionActionResponse {
  return { status: 200, body: {
    type: "intervene_ack", status: "ok", outcome: "delivered", agentSessionId,
    delivered: true, consumeWhen: null, reason: "card_question_answered",
  } };
}

async function admitAttachmentInput(
  options: SessionActionCommandRouteOptions,
  caller: FastifyRequest | ServiceCaller,
  payload: InterveneNodeCommandPayload,
): Promise<{ payload: InterveneNodeCommandPayload } | { response: SessionActionResponse }> {
  const inlineAttachments = payload.inline_attachments ?? [];
  const basePayload: InterveneNodeCommandPayload = { ...payload };
  delete basePayload.inline_attachments;
  if (inlineAttachments.length > 0 && options.uploadInlineAttachment === undefined) {
    return unavailableAttachmentInput();
  }
  if (payload.attachment_ids === undefined && payload.attachment_paths === undefined
    && inlineAttachments.length === 0) {
    return { payload: basePayload };
  }

  // 인라인 첨부는 업로드 전에 요청별 delivery_id를 확정한다. 같은 delivery_id의 재전송은
  // 같은 업로드 ID를 재사용하고, delivery_id가 없는 새 요청은 고유한 업로드 ID를 갖는다.
  const deliveryId = inlineAttachments.length > 0
    ? payload.delivery_id ?? randomUUID()
    : undefined;
  if (deliveryId !== undefined) basePayload.delivery_id = deliveryId;

  const attachmentIds = [...(payload.attachment_ids ?? [])];
  const attachmentPaths = [...(payload.attachment_paths ?? [])];
  for (const [index, file] of inlineAttachments.entries()) {
    const uploadId = inlineUploadId(`${deliveryId}:${index}:${file.name}`);
    const uploaded = await options.uploadInlineAttachment!(
      caller, payload.agentSessionId, file, uploadId,
    );
    attachmentPaths.push(uploaded.path);
    attachmentIds.push(uploaded.assetId ?? uploadId);
  }

  const withUploads: InterveneNodeCommandPayload = { ...basePayload };
  if (attachmentPaths.length > 0) withUploads.attachment_paths = attachmentPaths;
  if (attachmentIds.length > 0) withUploads.attachment_ids = attachmentIds;
  if (options.admitAttachmentInput === undefined) {
    return inlineAttachments.length > 0
      ? { payload: withUploads }
      : payload.attachment_ids === undefined
        ? { payload }
        : unavailableAttachmentInput();
  }
  try {
    const admitted = await options.admitAttachmentInput(caller, {
      sessionId: payload.agentSessionId,
      ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
      ...(attachmentPaths.length === 0 ? {} : { attachmentPaths }),
    });
    const admittedPayload: InterveneNodeCommandPayload = { ...basePayload };
    const admittedPaths = admitted.attachment_paths.length > 0 ? admitted.attachment_paths : attachmentPaths;
    const admittedIds = admitted.attachment_ids.length > 0 ? admitted.attachment_ids : attachmentIds;
    if (admittedPaths.length > 0) admittedPayload.attachment_paths = admittedPaths;
    if (admittedIds.length > 0) admittedPayload.attachment_ids = admittedIds;
    if (admitted.attachment_bindings.length > 0) {
      admittedPayload.attachment_bindings = admitted.attachment_bindings;
    }
    return { payload: admittedPayload };
  } catch (error) {
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (typeof code !== "string" || typeof statusCode !== "number") throw error;
    return { response: { status: statusCode, body: { error: {
      code, message: error instanceof Error ? error.message : code,
    } } } };
  }
}

function unavailableAttachmentInput(): { response: SessionActionResponse } {
  return { response: { status: 503, body: { error: {
    code: "ATTACHMENT_INPUT_UNAVAILABLE", message: "Attachment input is unavailable",
  } } } };
}

/** Stable upload identity so a retried delivery reuses the same stored object. */
function inlineUploadId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function admitDurableHumanIntervention(
  options: SessionActionCommandRouteOptions,
  payload: InterveneNodeCommandPayload,
): Promise<{
  payload: InterveneNodeCommandPayload;
  deliveryId?: string;
  conflict: boolean;
}> {
  if (
    options.deliveryRepositoryProvider === undefined
    || (
      payload.delivery_intent !== undefined
      && payload.delivery_intent !== "human_live_steer"
    )
  ) {
    return { payload, conflict: false };
  }
  const deliveryId = payload.delivery_id ?? randomUUID();
  const completionId = payload.completion_id ?? `message:${deliveryId}`;
  const relationKey = payload.relation_key
    ?? `user_message:${payload.agentSessionId}:${deliveryId}`;
  const source = payload.source ?? "user_message";
  const createdAt = parseCreatedAt(payload.created_at);
  const durablePayload = {
    ...payload,
    delivery_id: deliveryId,
    delivery_intent: "human_live_steer" as const,
    source,
    completion_id: completionId,
    relation_key: relationKey,
    created_at: createdAt.toISOString(),
  };
  const canonical = buildCanonicalDeliveryPayload({
    text: payload.text,
    conversationText: payload._conversation_text,
    user: payload.user,
    source,
    completionId,
    relationKey,
    attachmentPaths: payload.attachment_paths,
    attachmentIds: payload.attachment_ids,
    attachmentBindings: payload.attachment_bindings,
    context: payload.extra_context_items,
    callerInfo: payload.caller_info,
  });
  const repository = await options.deliveryRepositoryProvider();
  const registered = await repository.register({
    deliveryId,
    targetSessionId: payload.agentSessionId,
    relationKey,
    completionId,
    intent: "human_live_steer",
    source,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt,
  });
  return {
    payload: durablePayload,
    deliveryId,
    conflict: registered.conflict,
  };
}

function parseCreatedAt(value: string | undefined): Date {
  if (value === undefined) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("created_at must be an ISO timestamp");
  }
  return parsed;
}

function deprecatedSessionMessage(
  reply: FastifyReply,
  sessionId: string,
): FastifyReply {
  const deprecatedPath = `/api/sessions/${sessionId}/message`;
  const replacementPath = `/api/sessions/${sessionId}/intervene`;
  const replacementMethod = "POST";
  return reply
    .code(410)
    .headers({
      "X-Soulstream-Deprecated-Path": deprecatedPath,
      "X-Soulstream-Replacement-Path": replacementPath,
      "X-Soulstream-Desktop-Action": "hard-reload",
      "Cache-Control": "no-store",
    })
    .send({
      error: {
        code: "DEPRECATED_API_PATH",
        message:
          "Deprecated API path. Refresh the dashboard bundle and use " +
          `${replacementMethod} ${replacementPath}.`,
        deprecatedPath,
        replacementPath,
        replacementMethod,
        desktopAction: "hard-reload",
      },
    });
}

function sessionParams(request: FastifyRequest): SessionParams {
  return request.params as SessionParams;
}

function approvalParams(request: FastifyRequest): ApprovalParams {
  return request.params as ApprovalParams;
}
