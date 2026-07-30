import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  SessionTurnSummaryQuery,
  SessionTurnSummaryResponse,
} from "./session_turn_summary_read_service.js";

export type SessionTurnSummaryRouteOptions = {
  read: (
    sessionId: string,
    query: SessionTurnSummaryQuery,
  ) => Promise<SessionTurnSummaryResponse>;
  ensureAccess: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<boolean>;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function registerSessionTurnSummaryRoute(
  app: FastifyInstance,
  options: SessionTurnSummaryRouteOptions,
): void {
  app.get("/api/sessions/:session_id/turn-summaries", async (request, reply) => {
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
    const sessionId = (request.params as { session_id: string }).session_id;
    return options.read(sessionId, parsed.value);
  });
}

type ParseResult =
  | { ok: true; value: SessionTurnSummaryQuery }
  | { ok: false; field: string; message: string };

function parseQuery(query: unknown): ParseResult {
  const mode = queryString(query, "mode");
  if (mode !== "count" && mode !== "index" && mode !== "range") {
    return invalid("mode", "mode must be count, index, or range");
  }
  if (mode === "count") return { ok: true, value: { mode } };
  if (mode === "index") {
    const turnNumber = positiveInteger(query, "turn_number");
    return turnNumber === null
      ? invalid("turn_number", "turn_number must be a positive integer")
      : { ok: true, value: { mode, turnNumber } };
  }
  const fromTurnNumber = positiveInteger(query, "from_turn_number");
  if (fromTurnNumber === null) {
    return invalid(
      "from_turn_number",
      "from_turn_number must be a positive integer",
    );
  }
  const rawTo = queryString(query, "to_turn_number");
  const toTurnNumber = rawTo === undefined
    ? null
    : positiveInteger(query, "to_turn_number");
  if (rawTo !== undefined && toTurnNumber === null) {
    return invalid(
      "to_turn_number",
      "to_turn_number must be a positive integer",
    );
  }
  if (toTurnNumber !== null && toTurnNumber < fromTurnNumber) {
    return invalid(
      "to_turn_number",
      "to_turn_number must be greater than or equal to from_turn_number",
    );
  }
  const rawLimit = queryString(query, "limit");
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : positiveInteger(query, "limit");
  if (limit === null || limit > MAX_LIMIT) {
    return invalid("limit", `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return {
    ok: true,
    value: { mode, fromTurnNumber, toTurnNumber, limit },
  };
}

function queryString(query: unknown, key: string): string | undefined {
  if (query === null || typeof query !== "object") return undefined;
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(query: unknown, key: string): number | null {
  const raw = queryString(query, key);
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function invalid(field: string, message: string): ParseResult {
  return { ok: false, field, message };
}
