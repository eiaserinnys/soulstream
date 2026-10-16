import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionHistoryRouteOptions } from "./session_history_routes.js";
import { SessionResourceAccessError } from "./session_resource_access.js";

type EventAttachmentParams = {
  session_id: string;
  event_id: string;
};

export const sessionEventAttachmentRouteAuthRequirements = {
  "GET /api/sessions/:session_id/events/:event_id/attachments": true,
} as const;

export function registerSessionEventAttachmentRoutes(
  app: FastifyInstance,
  options: Pick<SessionHistoryRouteOptions, "provider" | "accessProvider">,
): void {
  app.get(
    "/api/sessions/:session_id/events/:event_id/attachments",
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const { session_id: sessionId, event_id: rawEventId } =
        request.params as EventAttachmentParams;
      if (options.accessProvider === undefined) {
        return sendUnavailable(reply);
      }

      try {
        await options.accessProvider.requireSessionAccess({ request, sessionId });
      } catch (error) {
        return sendAccessFailure(reply, error);
      }

      const eventId = positiveSafeInteger(rawEventId);
      if (eventId === undefined) {
        return reply.code(400).send({
          error: {
            code: "ATTACHMENT_EVENT_INVALID_ID",
            message: "event_id must be a positive safe integer",
          },
        });
      }

      if (options.provider.readEventAttachments === undefined) {
        return sendUnavailable(reply);
      }

      try {
        const projection = await options.provider.readEventAttachments(sessionId, eventId);
        if (projection === null) {
          return reply.code(404).send({
            error: {
              code: "ATTACHMENT_EVENT_NOT_FOUND",
              message: "Attachment event not found",
            },
          });
        }
        return reply.send(projection);
      } catch {
        return sendUnavailable(reply);
      }
    },
  );
}

function positiveSafeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sendAccessFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SessionResourceAccessError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  return sendUnavailable(reply);
}

function sendUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: {
      code: "ATTACHMENT_PROJECTION_UNAVAILABLE",
      message: "Attachment projection is unavailable",
    },
  });
}
