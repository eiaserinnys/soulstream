import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CardSessionMessages } from "./session_conversation_projection.js";

export type SessionConversationRouteOptions = {
  ensureAccess: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
  read: (sessionId: string, limit?: string) => Promise<CardSessionMessages | null>;
};

export const sessionConversationRouteAuthRequirements = {
  "GET /api/sessions/:session_id/conversation": true,
} as const;

export function registerSessionConversationRoute(app: FastifyInstance, options: SessionConversationRouteOptions): void {
  app.get<{ Params: { session_id: string }; Querystring: { limit?: string } }>(
    "/api/sessions/:session_id/conversation", async (request, reply) => {
      if (!await options.ensureAccess(request, reply)) return;
      const result = await options.read(request.params.session_id, request.query.limit);
      return result === null ? reply.code(404).send({ detail: "Session not found" }) : result;
    },
  );
}
