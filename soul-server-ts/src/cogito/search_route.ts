import type { FastifyInstance } from "fastify";

import type { McpRuntime } from "../mcp/runtime.js";
import { searchSessionEvents } from "../search/session_search.js";

export interface CogitoSearchRouteConfig {
  runtime: McpRuntime;
}

export function registerCogitoSearchRoute(
  fastify: FastifyInstance,
  config: CogitoSearchRouteConfig,
): void {
  fastify.get<{
    Querystring: {
      q?: string;
      top_k?: string | number;
      event_types?: string;
      search_session_id?: string | boolean;
    };
  }>("/cogito/search", async (request, reply) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    if (!query.trim()) {
      return reply.code(400).send({ detail: "q query parameter is required" });
    }

    const limit = normalizeTopK(request.query.top_k);
    const eventTypes = parseEventTypes(request.query.event_types);
    const searchSessionId = parseBoolean(request.query.search_session_id);
    const results = await searchSessionEvents(config.runtime.db, {
      query,
      limit,
      eventTypes,
      searchSessionId,
    });
    return { results };
  });
}

function normalizeTopK(value: string | number | undefined): number {
  const raw = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(100, Math.max(1, raw));
}

function parseEventTypes(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const types = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return types.length > 0 ? types : null;
}

function parseBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return value === "true" || value === "1";
}
