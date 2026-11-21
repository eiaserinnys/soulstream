import type { FastifyInstance, FastifyRequest } from "fastify";

import { queryInteger, queryValue, rawQueryValue } from "../http/route_validation.js";

import {
  SESSION_SNAPSHOT_MAX_TARGET_IDS,
  resolveSessionSnapshotIds,
  type SessionSnapshotListResponse,
  type SessionSnapshotQuery,
} from "./session_snapshot_service.js";

export type SessionSnapshotListProvider = {
  listSessions: (
    query: SessionSnapshotQuery,
    request: FastifyRequest,
  ) => SessionSnapshotListResponse | Promise<SessionSnapshotListResponse>;
};

export type SessionSnapshotRouteOptions = {
  snapshotService: SessionSnapshotListProvider;
};

export const sessionSnapshotRouteAuthRequirements = {
  "GET /api/sessions": true,
} as const;

export function registerSessionSnapshotRoutes(
  app: FastifyInstance,
  options: SessionSnapshotRouteOptions,
): void {
  app.get("/api/sessions", async (request, reply) => {
    if (hasInvalidTimestamp(request.query, "updated_after")) {
      return reply.code(422).send({ detail: "updated_after must be a valid timestamp" });
    }
    const query = parseSessionSnapshotQuery(request.query);
    if ((query.session_ids?.length ?? 0) > SESSION_SNAPSHOT_MAX_TARGET_IDS) {
      return reply.code(422).send({
        detail: `session_id must contain at most ${SESSION_SNAPSHOT_MAX_TARGET_IDS} values`,
      });
    }
    return options.snapshotService.listSessions(
      {
        ...query,
        session_ids: resolveSessionSnapshotIds(query.session_ids),
      },
      request,
    );
  });
}

function parseSessionSnapshotQuery(query: unknown): SessionSnapshotQuery {
  return {
    session_ids: stringArrayQuery(query, "session_id"),
    folderId: stringQuery(query, "folderId"),
    folder_id: stringQuery(query, "folder_id"),
    session_type: stringQuery(query, "session_type"),
    search: trimmedStringQuery(query, "search"),
    node_id: stringQuery(query, "node_id"),
    status: stringArrayQuery(query, "status"),
    backend: stringArrayQuery(query, "backend"),
    updated_after: stringQuery(query, "updated_after"),
    feed_only: booleanQuery(query, "feed_only"),
    feed_display: booleanQuery(query, "feed_display"),
    offset: queryInteger(query, "offset"),
    limit: queryInteger(query, "limit"),
    cursor: stringQuery(query, "cursor"),
  };
}

function stringArrayQuery(query: unknown, key: string): string[] | undefined {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  const raw = (query as Record<string, unknown>)[key];
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => typeof value === "string" ? value.split(",") : [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function stringQuery(query: unknown, key: string): string | undefined {
  const value = queryValue(query, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trimmedStringQuery(query: unknown, key: string): string | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function booleanQuery(query: unknown, key: string): boolean | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function hasInvalidTimestamp(query: unknown, key: string): boolean {
  const raw = rawQueryValue(query, key);
  if (raw === undefined) return false;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value));
}
