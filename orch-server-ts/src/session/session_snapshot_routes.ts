import type { FastifyInstance } from "fastify";

import {
  SessionSnapshotService,
  type SessionSnapshotQuery,
} from "./session_snapshot_service.js";

export type SessionSnapshotRouteOptions = {
  snapshotService: SessionSnapshotService;
};

export const sessionSnapshotRouteAuthRequirements = {
  "GET /api/sessions": true,
} as const;

export function registerSessionSnapshotRoutes(
  app: FastifyInstance,
  options: SessionSnapshotRouteOptions,
): void {
  app.get("/api/sessions", async (request) =>
    options.snapshotService.listSessions(parseSessionSnapshotQuery(request.query)),
  );
}

function parseSessionSnapshotQuery(query: unknown): SessionSnapshotQuery {
  return {
    folderId: stringQuery(query, "folderId"),
    folder_id: stringQuery(query, "folder_id"),
    session_type: stringQuery(query, "session_type"),
    feed_only: booleanQuery(query, "feed_only"),
    offset: numberQuery(query, "offset"),
    limit: numberQuery(query, "limit"),
    cursor: stringQuery(query, "cursor"),
  };
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
