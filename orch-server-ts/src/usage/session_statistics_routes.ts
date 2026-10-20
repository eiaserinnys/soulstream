import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  USAGE_STATS_PROVIDERS,
  type UsageStatsPeriod,
  type UsageStatsProvider,
  type UsageStatsQuery,
} from "@soulstream/wire-schema/session-statistics";

import {
  filterFolders,
  normalizeAccess,
  type FolderAccess,
  type FolderRecord,
} from "../folders/folder_route_access.js";
import type { FolderRouteProvider } from "../folders/folder_routes.js";
import {
  DashboardAccessError,
  type LiveDashboardAccessProvider,
} from "../runtime/live_dashboard_access_provider.js";
import type { SessionStatisticsService } from "./session_statistics_service.js";

const TIMEZONE = "Asia/Seoul" as const;
const QUERY_KEYS = new Set([
  "period",
  "anchor",
  "timezone",
  "provider",
  "model",
  "project_ids",
]);
const VALID_PERIODS = new Set<UsageStatsPeriod>(["week", "month", "all"]);
const VALID_PROVIDERS = new Set<UsageStatsProvider>(USAGE_STATS_PROVIDERS);
const INVALID_QUERY = { detail: "Invalid session statistics query" } as const;
const INVALID_DATE = { detail: "Invalid session statistics date" } as const;
const ACCESS_DENIED = { detail: "Session statistics access denied" } as const;
const UNAVAILABLE = { detail: "Session statistics unavailable" } as const;

export type SessionStatisticsRouteOptions = {
  service: Pick<SessionStatisticsService, "getOverview" | "getDay"> & { close?: () => void };
  accessProvider: Pick<LiveDashboardAccessProvider, "resolveAccess">;
  folderProvider: Pick<FolderRouteProvider, "listFolders">;
  now: () => Date;
};

export const sessionStatisticsRouteAuthRequirements = {
  "GET /api/session-statistics": true,
  "GET /api/session-statistics/days/:date": true,
} as const;

type QueryResult =
  | { readonly ok: true; readonly query: UsageStatsQuery }
  | { readonly ok: false };

export function registerSessionStatisticsRoutes(
  app: FastifyInstance,
  options: SessionStatisticsRouteOptions,
): void {
  app.addHook("onClose", async () => { options.service.close?.(); });
  app.get("/api/session-statistics", async (request, reply) => {
    const scope = await resolveScope(request, reply, options);
    if (scope === null) return;
    const parsed = parseQuery(request.query, scope.asOf);
    if (!parsed.ok) return reply.code(400).send(INVALID_QUERY);
    if (!isVisibleProjectSelection(parsed.query.project_ids, scope.visibleFolders)) {
      return reply.code(403).send(ACCESS_DENIED);
    }
    try {
      return await options.service.getOverview({
        query: parsed.query,
        timezone: TIMEZONE,
        asOf: scope.asOf,
        access: scope.access,
        visibleFolders: scope.visibleFolders,
        day: null,
      });
    } catch (error) {
      return unavailable(request, reply, error);
    }
  });

  app.get("/api/session-statistics/days/:date", async (request, reply) => {
    const scope = await resolveScope(request, reply, options);
    if (scope === null) return;
    const parsed = parseQuery(request.query, scope.asOf);
    if (!parsed.ok) return reply.code(400).send(INVALID_QUERY);
    if (!isVisibleProjectSelection(parsed.query.project_ids, scope.visibleFolders)) {
      return reply.code(403).send(ACCESS_DENIED);
    }
    const date = (request.params as { readonly date: string }).date;
    if (!isCalendarDate(date)) return reply.code(400).send(INVALID_DATE);
    try {
      return await options.service.getDay({
        query: parsed.query,
        timezone: TIMEZONE,
        asOf: scope.asOf,
        access: scope.access,
        visibleFolders: scope.visibleFolders,
        day: date,
      });
    } catch (error) {
      if (isOutOfPeriodDay(error)) return reply.code(400).send(INVALID_DATE);
      return unavailable(request, reply, error);
    }
  });
}

type ResolvedScope = {
  readonly access: Required<FolderAccess>;
  readonly visibleFolders: readonly FolderRecord[];
  readonly asOf: string;
};

async function resolveScope(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SessionStatisticsRouteOptions,
): Promise<ResolvedScope | null> {
  let rawAccess: FolderAccess;
  try {
    rawAccess = await options.accessProvider.resolveAccess(request);
  } catch (error) {
    if (error instanceof DashboardAccessError && error.statusCode === 401) {
      reply.code(401).send({ detail: error.message });
      return null;
    }
    if (error instanceof DashboardAccessError && error.statusCode === 403) {
      reply.code(403).send(ACCESS_DENIED);
      return null;
    }
    unavailable(request, reply, error);
    return null;
  }

  let asOf: string;
  try {
    asOf = options.now().toISOString();
  } catch (error) {
    unavailable(request, reply, error);
    return null;
  }

  try {
    const access = normalizeAccess(rawAccess);
    if (access.restricted && access.allowedFolderIds.length === 0) {
      reply.code(403).send(ACCESS_DENIED);
      return null;
    }
    const allFolders = await options.folderProvider.listFolders();
    const visibleFolders = filterFolders(access, allFolders);
    if (access.restricted && visibleFolders.length === 0) {
      reply.code(403).send(ACCESS_DENIED);
      return null;
    }
    return { access, visibleFolders, asOf };
  } catch (error) {
    unavailable(request, reply, error);
    return null;
  }
}

function parseQuery(query: unknown, asOf: string): QueryResult {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return { ok: false };
  }
  const values = query as Record<string, unknown>;
  const hasInvalidEntry = Object.entries(values).some(([key, value]) =>
    !QUERY_KEYS.has(key) || typeof value !== "string",
  );
  if (hasInvalidEntry) return { ok: false };

  const periodValue = scalar(values, "period");
  const period = periodValue === undefined ? "week" : periodValue;
  if (!VALID_PERIODS.has(period as UsageStatsPeriod)) return { ok: false };

  const timezone = scalar(values, "timezone");
  if (timezone !== undefined && timezone !== TIMEZONE) return { ok: false };

  const anchorValue = scalar(values, "anchor");
  const anchor = anchorValue ?? todayInKst(new Date(asOf));
  if (!isCalendarDate(anchor)) return { ok: false };

  const providerValue = scalar(values, "provider");
  if (providerValue !== undefined && !VALID_PROVIDERS.has(providerValue as UsageStatsProvider)) {
    return { ok: false };
  }

  const modelValue = scalar(values, "model");
  if (modelValue !== undefined && modelValue.trim().length === 0) return { ok: false };

  const projectIdsValue = scalar(values, "project_ids");
  const projectIds = projectIdsValue === undefined
    ? undefined
    : parseProjectIds(projectIdsValue);
  if (projectIds === null) return { ok: false };

  return {
    ok: true,
    query: {
      period: period as UsageStatsPeriod,
      anchor,
      ...(providerValue === undefined ? {} : { provider: providerValue as UsageStatsProvider }),
      ...(modelValue === undefined ? {} : { model: modelValue }),
      ...(projectIds === undefined ? {} : { project_ids: projectIds }),
    },
  };
}

function scalar(values: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(values, key)) return undefined;
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function parseProjectIds(value: string): string[] | null {
  const ids = value.split(",").map((id) => id.trim());
  if (ids.some((id) => id.length === 0 || id === "__other__")) return null;
  return [...new Set(ids)];
}

function isVisibleProjectSelection(
  projectIds: readonly string[] | undefined,
  visibleFolders: readonly FolderRecord[],
): boolean {
  if (projectIds === undefined) return true;
  const visibleFolderIds = new Set(visibleFolders.map((folder) => folder.id));
  const visibleProjectIds = new Set(
    visibleFolders
      .filter((folder) =>
        typeof folder.parentFolderId !== "string" ||
        !visibleFolderIds.has(folder.parentFolderId),
      )
      .map((folder) => folder.id),
  );
  return projectIds.every((id) =>
    id === "__unclassified__" || visibleProjectIds.has(id),
  );
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function todayInKst(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("session statistics KST date unavailable");
  }
  return `${year}-${month}-${day}`;
}

function isOutOfPeriodDay(error: unknown): boolean {
  return error instanceof Error &&
    error.message === "session statistics day is outside the selected period";
}

function unavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  request.server.log.error({ cause_code: causeCode(error) });
  return reply.code(503).send(UNAVAILABLE);
}

function causeCode(error: unknown): string {
  if (
    error !== null && typeof error === "object" &&
    "code" in error && typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(error.code)
  ) {
    return error.code;
  }
  return "UNSPECIFIED";
}
