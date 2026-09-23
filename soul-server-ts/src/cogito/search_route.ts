import type { FastifyInstance } from "fastify";
import {
  DEFAULT_SEARCH_CATEGORIES,
  eventTypesForSearchCategories,
  parseSearchEventCategories,
} from "@soulstream/search-contract";

import type { McpRuntime } from "../mcp/runtime.js";
import {
  searchSessionEvents,
  SessionHistorySearchDeadlineError,
} from "../search/session_search.js";

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
      event_categories?: string;
      search_session_id?: string | boolean;
      include_turn_summaries?: string | boolean;
      include_highlight?: string | boolean;
      include_story?: string | boolean;
    };
  }>("/cogito/search", async (request, reply) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    if (!query.trim()) {
      return reply.code(400).send({ detail: "q query parameter is required" });
    }

    const limit = normalizeTopK(request.query.top_k);
    const categories = parseSearchEventCategories(request.query.event_categories);
    const eventTypes = parseEventTypes(request.query.event_types) ??
      eventTypesForSearchCategories(categories ?? DEFAULT_SEARCH_CATEGORIES);
    const searchSessionId = parseBoolean(request.query.search_session_id);
    const controller = new AbortController();
    const onRequestAborted = () => controller.abort();
    const onResponseClosed = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onResponseClosed);
    try {
      const results = await searchSessionEvents(config.runtime.db, {
        query,
        limit,
        eventTypes,
        searchSessionId,
        includeTurnSummaries: parseBoolean(request.query.include_turn_summaries),
        includeHighlight: parseBoolean(request.query.include_highlight),
        includeStory: parseBoolean(request.query.include_story),
        signal: controller.signal,
      });
      return { results };
    } catch (error) {
      if (request.raw.aborted || reply.raw.destroyed) return reply;
      if (error instanceof SessionHistorySearchDeadlineError || hasTimeoutStatus(error)) {
        return reply.code(504).send({ detail: "search deadline exceeded" });
      }
      throw error;
    } finally {
      request.raw.removeListener("aborted", onRequestAborted);
      reply.raw.removeListener("close", onResponseClosed);
    }
  });
}

function hasTimeoutStatus(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("statusCode" in error && error.statusCode === 504) return true;
  if ("cause" in error) {
    const cause = error.cause;
    return typeof cause === "object" && cause !== null
      && "status" in cause && cause.status === 504;
  }
  return false;
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
