import { randomUUID } from "node:crypto";

import { buildCanonicalDeliveryPayload } from "@soulstream/wire-schema/delivery";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionDeliveryRepository } from
  "../control_plane/repositories/session_delivery_repository.js";

import {
  badRequest,
  sendActionCommand,
  sendGenericStatusError,
  sendInterveneCommand,
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
  type InterveneNodeCommandPayload,
  type InterruptNodeCommandPayload,
  type JsonObject,
  type AcknowledgeSessionReviewNodeCommandPayload,
  type SessionParams,
} from "./session_action_command_payloads.js";
import type { SessionReviewAcknowledgeFallback } from "./session_review_acknowledge_fallback.js";

export type SessionActionCallerInfoResolver = (
  request: FastifyRequest,
  bodyCallerInfo: JsonObject | undefined,
  targetSessionId: string,
) => Promise<JsonObject> | JsonObject;

export type SessionActionCommandRouteOptions =
  SessionActionCommandDispatchOptions & {
    resolveCallerInfo?: SessionActionCallerInfoResolver;
    reviewAcknowledgeFallback?: SessionReviewAcknowledgeFallback;
    deliveryRepositoryProvider?: () => Promise<Pick<SessionDeliveryRepository, "register">>;
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
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (body === undefined) {
        return badRequest(reply, "Request body must be a JSON object");
      }

      const targetSessionId = sessionParams(request).session_id;
      const payload = intervenePayload(targetSessionId, body);
      if (!payload.ok) return badRequest(reply, payload.message);
      if (options.resolveCallerInfo !== undefined) {
        payload.value.caller_info = await options.resolveCallerInfo(
          request,
          payload.value.caller_info,
          targetSessionId,
        );
      }
      const durable = await admitDurableHumanIntervention(
        options,
        payload.value,
      );
      if (durable.conflict) {
        return reply.code(409).send({
          error: {
            code: "DELIVERY_IDENTITY_CONFLICT",
            message: `Delivery identity conflict: ${durable.deliveryId}`,
            deliveryId: durable.deliveryId,
          },
        });
      }
      return sendInterveneCommand(
        reply,
        options,
        durable.payload,
        durable.deliveryId,
      );
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
    user: payload.user,
    source,
    completionId,
    relationKey,
    attachmentPaths: payload.attachment_paths,
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
