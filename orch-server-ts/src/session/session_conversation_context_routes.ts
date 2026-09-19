import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  SessionConversationContextQuery,
  SessionConversationContextResponse,
} from "./session_conversation_context.js";

type SessionParams = { session_id: string };

export type SessionConversationContextRouteOptions = {
  readonly read: (
    sessionId: string,
    query: SessionConversationContextQuery,
  ) => Promise<SessionConversationContextResponse | null>;
  readonly ensureAccess: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<boolean>;
};

const DEFAULT_ADJACENT_TURNS = 1;
const MAX_ADJACENT_TURNS = 2;

export function registerSessionConversationContextRoute(
  app: FastifyInstance,
  options: SessionConversationContextRouteOptions,
): void {
  app.get(
    "/api/sessions/:session_id/conversation-context",
    async (request, reply) => {
      const parsed = parseQuery(request.query);
      if (!parsed.ok) {
        return reply.code(400).send({
          error: {
            code: "INVALID_QUERY",
            message: parsed.message,
            details: { field: parsed.field },
          },
        });
      }
      if (!(await options.ensureAccess(request, reply))) return;
      const sessionId = (request.params as SessionParams).session_id;
      const context = await options.read(sessionId, parsed.value);
      if (context !== null) return context;
      return reply.code(404).send({
        error: {
          code: "EVENT_NOT_FOUND",
          message: `세션에서 이벤트를 찾을 수 없습니다: ${parsed.value.eventId}`,
          details: {},
        },
      });
    },
  );
}

type ParsedQuery =
  | { readonly ok: true; readonly value: SessionConversationContextQuery }
  | { readonly ok: false; readonly field: string; readonly message: string };

function parseQuery(query: unknown): ParsedQuery {
  const eventId = optionalPositiveInteger(queryValue(query, "event_id"), "event_id");
  if (!eventId.ok) return eventId;
  const beforeTurns = adjacentTurns(
    queryValue(query, "before_turns"),
    "before_turns",
  );
  if (!beforeTurns.ok) return beforeTurns;
  const afterTurns = adjacentTurns(
    queryValue(query, "after_turns"),
    "after_turns",
  );
  if (!afterTurns.ok) return afterTurns;
  return {
    ok: true,
    value: {
      eventId: eventId.value,
      beforeTurns: beforeTurns.value,
      afterTurns: afterTurns.value,
    },
  };
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): { readonly ok: true; readonly value: number | null } | Exclude<ParsedQuery, { ok: true }> {
  if (value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return { ok: false, field, message: `${field} must be a positive integer` };
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, field, message: `${field} must be a positive integer` };
}

function adjacentTurns(
  value: unknown,
  field: string,
): { readonly ok: true; readonly value: number } | Exclude<ParsedQuery, { ok: true }> {
  if (value === undefined || value === "") {
    return { ok: true, value: DEFAULT_ADJACENT_TURNS };
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return { ok: false, field, message: `${field} must be an integer between 0 and 2` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_ADJACENT_TURNS) {
    return { ok: false, field, message: `${field} must be an integer between 0 and 2` };
  }
  return { ok: true, value: parsed };
}

function queryValue(query: unknown, key: string): unknown {
  if (query === null || typeof query !== "object" || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
}

