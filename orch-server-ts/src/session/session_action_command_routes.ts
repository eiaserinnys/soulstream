import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  badRequest,
  sendActionCommand,
  sendGenericStatusError,
  sendInterruptAckError,
  sendReviewAcknowledgeAckError,
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
  type InterruptNodeCommandPayload,
  type AcknowledgeSessionReviewNodeCommandPayload,
  type SessionParams,
} from "./session_action_command_payloads.js";

export type SessionActionCommandRouteOptions =
  SessionActionCommandDispatchOptions;

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

      const payload = intervenePayload(sessionParams(request).session_id, body);
      if (!payload.ok) return badRequest(reply, payload.message);

      return sendActionCommand(reply, options, payload.value, sendGenericStatusError);
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/review/acknowledge",
    async (request, reply) => {
      const payload: AcknowledgeSessionReviewNodeCommandPayload = {
        type: "acknowledge_session_review",
        agentSessionId: sessionParams(request).session_id,
      };
      return sendActionCommand(
        reply,
        options,
        payload,
        sendReviewAcknowledgeAckError,
      );
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
