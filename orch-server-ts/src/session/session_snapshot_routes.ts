import type { FastifyInstance, FastifyRequest } from "fastify";

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
    feed_only: booleanQuery(query, "feed_only"),
    offset: numberQuery(query, "offset"),
    limit: numberQuery(query, "limit"),
    cursor: stringQuery(query, "cursor"),
  };
}

function stringArrayQuery(query: unknown, key: string): string[] | undefined {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  const raw = (query as Record<string, unknown>)[key];
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function stringQuery(query: unknown, key: string): string | undefined {
  const value = queryValue(query, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberQuery(query: unknown, key: string): number | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanQuery(query: unknown, key: string): boolean | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function queryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
}
