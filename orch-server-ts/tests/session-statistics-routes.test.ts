import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  DashboardAccessError,
  createApp,
  parseOrchServerConfig,
  type SessionStatisticsRouteOptions,
} from "../src/index.js";
import { sessionStatisticsSourceKey } from "../src/usage/session_statistics_aggregate.js";
import { SessionStatisticsService } from "../src/usage/session_statistics_service.js";
import type {
  SessionStatisticsReadRequest,
  SessionStatisticsReadResult,
  SessionStatisticsScopeSession,
} from "../src/usage/session_statistics_types.js";
import {
  fact as statisticsFact,
  materialRow as statisticsMaterialRow,
  read as createStatisticsRead,
  usageRow as statisticsUsageRow,
} from "./fixtures/session_statistics_aggregation.fixtures.js";

const config = parseOrchServerConfig({
  environment: "production",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "statistics-service-token",
});

const folders = [
  { id: "hidden-root", name: "Hidden root", parentFolderId: null },
  { id: "visible-child", name: "Visible project", parentFolderId: "hidden-root" },
  { id: "visible-grandchild", name: "Visible child", parentFolderId: "visible-child" },
  { id: "hidden-child", name: "Hidden child", parentFolderId: "hidden-root" },
  { id: "other-project", name: "Other project", parentFolderId: null },
];

describe("session statistics routes", () => {
  it("serves overview through cookie and Bearer auth with one fixed KST clock value", async () => {
    const harness = createHarness();
    try {
      const cookie = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics",
        headers: { cookie: `${AUTH_COOKIE_NAME}=dashboard-token` },
      });
      const bearer = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics",
        headers: { authorization: "Bearer statistics-service-token" },
      });

      expect(cookie.statusCode).toBe(200);
      expect(cookie.json()).toEqual({ route: "overview" });
      expect(bearer.statusCode).toBe(200);
      expect(bearer.json()).toEqual({ route: "overview" });
      expect(harness.read).toHaveBeenCalledTimes(2);
      expect(harness.now).toHaveBeenCalledTimes(2);
      expect(harness.read.mock.calls[0]?.[0]).toMatchObject({
        query: { period: "week", anchor: "2026-10-20" },
        timezone: "Asia/Seoul",
        asOf: "2026-10-20T01:02:03.000Z",
      });
      expect(harness.getOverview).toHaveBeenCalledTimes(2);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects unauthenticated requests before access, clock, or repository work", async () => {
    const harness = createHarness();
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics",
      });

      expect(response.statusCode).toBe(401);
      expect(harness.resolveAccess).not.toHaveBeenCalled();
      expect(harness.now).not.toHaveBeenCalled();
      expect(harness.read).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("preserves the dashboard access provider's 401 detail", async () => {
    const harness = createHarness();
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics",
        headers: { cookie: `${AUTH_COOKIE_NAME}=expired` },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ detail: "Dashboard session expired" });
      expect(harness.now).not.toHaveBeenCalled();
      expect(harness.read).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("uses only permission-filtered folders and gives hidden and absent projects the same 403", async () => {
    const harness = createHarness();
    const headers = { cookie: `${AUTH_COOKIE_NAME}=restricted` };
    try {
      const allowed = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics?project_ids=%20visible-child%20,visible-child,__unclassified__",
        headers,
      });
      expect(allowed.statusCode).toBe(200);
      expect(harness.read.mock.calls[0]?.[0]).toMatchObject({
        query: { project_ids: ["visible-child", "__unclassified__"] },
        visibleFolders: [
          { id: "visible-child", name: "Visible project" },
          { id: "visible-grandchild", name: "Visible child" },
        ],
      });

      const hidden = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics?project_ids=hidden-root",
        headers,
      });
      const absent = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics?project_ids=not-a-project",
        headers,
      });

      expect(hidden.statusCode).toBe(403);
      expect(absent.statusCode).toBe(403);
      expect(hidden.json()).toEqual({ detail: "Session statistics access denied" });
      expect(absent.json()).toEqual(hidden.json());
      expect(JSON.stringify(hidden.json())).not.toContain("hidden-root");
      expect(harness.read).toHaveBeenCalledTimes(1);
    } finally {
      await harness.app.close();
    }
  });

  it("keeps HTTP totals, options, all-period earliest date, cost, and day material inside the visible child scope", async () => {
    const repository = createScopedStatisticsRepository();
    const service = new SessionStatisticsService(async () => repository);
    const harness = createHarness(service);
    const headers = { cookie: `${AUTH_COOKIE_NAME}=restricted` };
    try {
      const overview = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics?period=all&anchor=2026-10-20",
        headers,
      });
      expect(overview.statusCode).toBe(200);
      const result = overview.json();
      expect(result.range).toMatchObject({
        period: "all",
        since: "2018-01-01",
        timezone: "Asia/Seoul",
      });
      expect(result.totals.metrics).toMatchObject({
        total_tokens: 125,
        reference_cost_usd: 0.12,
      });
      expect(result.options.models.map((model: { model: string | null }) => model.model))
        .toEqual(["visible-model"]);
      expect(result.options.projects.map((project: { project_id: string }) => project.project_id))
        .toEqual(["visible-child"]);
      expect(result.options.project_roster).toEqual(["visible-child"]);
      expect(JSON.stringify(result)).not.toMatch(/hidden-root|hidden-child|hidden-model|fallback-model/);

      const day = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics/days/2018-01-01?period=all&anchor=2026-10-20",
        headers,
      });
      expect(day.statusCode).toBe(200);
      expect(day.json().totals.metrics).toMatchObject({
        total_tokens: 5,
        reference_cost_usd: 0.02,
      });
      expect(day.json().input_material.observed_approximate_tokens).toBe(2);
      expect(JSON.stringify(day.json())).not.toMatch(/hidden-root|hidden-child|hidden-model|fallback-model|777/);
      expect(repository.read).toHaveBeenCalledTimes(2);
      expect(repository.read.mock.calls[0]?.[0].visibleFolders.map((folder) => folder.id))
        .toEqual(["visible-child", "visible-grandchild"]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects restricted access with no visible folders before validating query or reading", async () => {
    const harness = createHarness();
    harness.listFolders.mockRejectedValueOnce(new Error("folder list should not be read"));
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics?timezone=UTC",
        headers: { cookie: `${AUTH_COOKIE_NAME}=empty` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ detail: "Session statistics access denied" });
      expect(harness.getOverview).not.toHaveBeenCalled();
      expect(harness.now).toHaveBeenCalledOnce();
      expect(harness.listFolders).not.toHaveBeenCalled();
      expect(harness.read).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it.each([
    "/api/session-statistics?unknown=1",
    "/api/session-statistics?project_roster=visible-child",
    "/api/session-statistics?period%5Bvalue%5D=week",
    "/api/session-statistics?period=week&period=month",
    "/api/session-statistics?period=year",
    "/api/session-statistics?provider=not-supported",
    "/api/session-statistics?timezone=UTC",
    "/api/session-statistics?anchor=2026-02-30",
    "/api/session-statistics?model=%20%20",
    "/api/session-statistics?project_ids=one,,two",
    "/api/session-statistics?project_ids=__other__",
  ])("rejects invalid query %s with a fixed 400", async (url) => {
    const harness = createHarness();
    try {
      const response = await harness.app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer statistics-service-token" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ detail: "Invalid session statistics query" });
      expect(harness.getOverview).not.toHaveBeenCalled();
      expect(harness.read).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("serves day detail with the same scope and rejects invalid or out-of-period dates", async () => {
    const harness = createHarness();
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics/days/2026-10-19?period=week&anchor=2026-10-20",
        headers: { authorization: "Bearer statistics-service-token" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ route: "day" });
      expect(harness.getDay).toHaveBeenCalledWith(expect.objectContaining({
        day: "2026-10-19",
        access: { restricted: false, allowedFolderIds: [] },
      }));
      expect(harness.read).toHaveBeenCalledTimes(1);

      const invalid = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics/days/2026-02-30",
        headers: { authorization: "Bearer statistics-service-token" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ detail: "Invalid session statistics date" });
      expect(harness.getDay).toHaveBeenCalledTimes(1);
    } finally {
      await harness.app.close();
    }
  });

  it("maps repository and period failures to fixed, nonrevealing responses", async () => {
    const harness = createHarness();
    harness.getOverview.mockRejectedValueOnce(
      Object.assign(new Error("private SQL and hidden-root payload"), { code: "42P01" }),
    );
    harness.getDay.mockRejectedValueOnce(
      new Error("session statistics day is outside the selected period"),
    );
    try {
      const unavailable = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics",
        headers: { authorization: "Bearer statistics-service-token" },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ detail: "Session statistics unavailable" });
      expect(unavailable.body).not.toContain("private SQL");
      expect(unavailable.body).not.toContain("hidden-root");

      const outsidePeriod = await harness.app.inject({
        method: "GET",
        url: "/api/session-statistics/days/2026-10-01?period=week&anchor=2026-10-20",
        headers: { authorization: "Bearer statistics-service-token" },
      });
      expect(outsidePeriod.statusCode).toBe(400);
      expect(outsidePeriod.json()).toEqual({ detail: "Invalid session statistics date" });
    } finally {
      await harness.app.close();
    }
  });
});

function createHarness(serviceOverride?: SessionStatisticsRouteOptions["service"]) {
  const now = vi.fn(() => new Date("2026-10-20T01:02:03.000Z"));
  const read = vi.fn(async (_input: unknown) => undefined);
  const getOverview = vi.fn(async (input: unknown) => {
    await read(input);
    return { route: "overview" };
  });
  const getDay = vi.fn(async (input: unknown) => {
    await read(input);
    return { route: "day" };
  });
  const resolveAccess = vi.fn(async (request: FastifyRequest) => {
    const cookie = request.headers.cookie ?? "";
    if (cookie.includes(`${AUTH_COOKIE_NAME}=expired`)) {
      throw new DashboardAccessError(
        "AUTHENTICATION_EXPIRED",
        "Dashboard session expired",
        401,
      );
    }
    if (cookie.includes(`${AUTH_COOKIE_NAME}=empty`)) {
      return { restricted: true, allowedFolderIds: [] };
    }
    if (cookie.includes(`${AUTH_COOKIE_NAME}=restricted`)) {
      return { restricted: true, allowedFolderIds: ["visible-child"] };
    }
    if (
      cookie.startsWith(`${AUTH_COOKIE_NAME}=`) ||
      request.headers.authorization === "Bearer statistics-service-token"
    ) {
      return { restricted: false, allowedFolderIds: [] };
    }
    throw new DashboardAccessError(
      "AUTHENTICATION_REQUIRED",
      "Authorization header required",
      401,
    );
  });
  const resolveTokenAccess = vi.fn(async (request: FastifyRequest) => {
    const accepted = request.headers.authorization === "Bearer statistics-service-token" ||
      request.headers.cookie?.startsWith(`${AUTH_COOKIE_NAME}=`) === true;
    return accepted
      ? { ok: true as const }
      : {
          ok: false as const,
          statusCode: 401,
          detail: "Authorization header required",
        };
  });
  const listFolders = vi.fn(async () => folders);
  const routeOptions = {
    service: serviceOverride ?? { getOverview, getDay },
    accessProvider: { resolveAccess },
    folderProvider: { listFolders },
    now,
  } as unknown as SessionStatisticsRouteOptions;
  const app = createApp({
    config,
    productionAuth: { resolveTokenAccess },
    sessionStatisticsRoutes: routeOptions,
  });

  return { app, getDay, getOverview, listFolders, now, read, resolveAccess };
}

function createScopedStatisticsRepository() {
  const sessions: SessionStatisticsScopeSession[] = [
    { sessionId: "visible-session", folderId: "visible-child", cardFolderId: null, projectId: "visible-child", projectLabel: "Visible project" },
    { sessionId: "hidden-session", folderId: "hidden-child", cardFolderId: null, projectId: "hidden-root", projectLabel: "Hidden project" },
    { sessionId: "fallback-session", folderId: null, cardFolderId: "visible-child", projectId: "visible-child", projectLabel: "Visible project" },
  ];
  const rows = [
    usageFixture("visible-session", 1, "2018-01-01T12:00:00.000Z", "visible-old", 4, 1, 0.02, "visible-model"),
    usageFixture("visible-session", 20, "2026-10-19T12:00:00.000Z", "visible-current", 100, 20, 0.1, "visible-model"),
    usageFixture("hidden-session", 1, "2010-01-01T12:00:00.000Z", "hidden-old", 600, 300, 7, "hidden-model"),
    usageFixture("hidden-session", 20, "2026-10-19T12:00:00.000Z", "hidden-current", 500, 200, 9, "hidden-model"),
    usageFixture("fallback-session", 1, "2011-01-01T12:00:00.000Z", "fallback-old", 300, 100, 4, "fallback-model"),
    usageFixture("fallback-session", 20, "2026-10-19T12:00:00.000Z", "fallback-current", 250, 100, 5, "fallback-model"),
    dayMaterial("visible-session", "visible-source", 2, "visible-old", "visible-old-input", "2018-01-01T12:00:00.000Z"),
    dayMaterial("hidden-session", "hidden-source", 777, "hidden-old", "hidden-old-input", "2010-01-01T12:00:00.000Z"),
  ];
  const costDecimals = new Map(
    rows
      .filter((row) => row.row_kind === "usage")
      .map((row) => {
        const fact = row.fact!;
        return [
          sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key),
          String(fact.known_cost_usd),
        ] as const;
      }),
  );

  return {
    read: vi.fn(async (input: SessionStatisticsReadRequest): Promise<SessionStatisticsReadResult> => {
      const visibleFolderIds = new Set(input.visibleFolders.map((folder) => folder.id));
      const authorizedSessions = sessions.filter((session) =>
        !input.access.restricted ||
        (session.folderId !== null && visibleFolderIds.has(session.folderId)),
      );
      const authorizedSessionIds = new Set(authorizedSessions.map((session) => session.sessionId));
      const authorizedRows = rows.filter((row) => authorizedSessionIds.has(row.session_id));
      const earliest = authorizedRows
        .map((row) => row.owner_recorded_at ?? row.fact?.recorded_at ?? null)
        .filter((value): value is string => value !== null)
        .sort()[0];
      const since = earliest?.slice(0, 10) ?? "2026-10-20";
      if (input.day !== null && (input.day < since || input.day >= "2026-10-21")) {
        throw new Error("session statistics day is outside the selected period");
      }
      const authorizedCosts = new Map([...costDecimals].filter(([key]) =>
        authorizedSessionIds.has(JSON.parse(key)[0] as string),
      ));
      const result = createStatisticsRead(
        authorizedRows,
        { ...input.query },
        authorizedCosts,
        authorizedSessions,
      ) as SessionStatisticsReadResult;
      return {
        ...result,
        query: input.query,
        asOf: input.asOf,
        range: {
          period: "all",
          since,
          until: "2026-10-21",
          effective_until: "2026-10-21",
          timezone: "Asia/Seoul",
          bucket: "month",
        },
      };
    }),
  };
}

function usageFixture(
  sessionId: string,
  eventId: number,
  recordedAt: string,
  commandId: string,
  inputTotal: number,
  outputTotal: number,
  knownCost: number,
  model: string,
) {
  const inputId = `${commandId}-input`;
  const totalTokens = inputTotal + outputTotal;
  return statisticsUsageRow({
    session_id: sessionId,
    selection_event_id: eventId,
    input_id: inputId,
    accounting_key: commandId,
    owner_event_id: eventId,
    owner_recorded_at: recordedAt,
    fact: statisticsFact({ session_id: sessionId, event_id: eventId, part_key: "usage:aggregate", recorded_at: recordedAt,
      accounting_key: commandId, input_id: inputId, model, input_total: inputTotal, output_total: outputTotal,
      total_tokens: totalTokens, known_cost_usd: knownCost, priced_tokens: totalTokens, unpriced_tokens: 0,
      pricing_complete: true, pricing_version: "price-v1" }),
  });
}

function dayMaterial(
  sessionId: string,
  sourceKey: string,
  approximateTokens: number,
  commandId: string,
  inputId: string,
  recordedAt: string,
) {
  const material = statisticsMaterialRow(2, sourceKey, approximateTokens, {
    session_id: sessionId, recorded_at: recordedAt, accounting_key: commandId, input_id: inputId,
  });
  return { ...material, session_id: sessionId, input_id: inputId, accounting_key: commandId, owner_recorded_at: recordedAt };
}
