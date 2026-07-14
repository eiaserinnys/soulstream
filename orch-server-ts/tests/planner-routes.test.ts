import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  plannerRouteAuthRequirements,
  registerPlannerRoutes,
  type PlannerReadProvider,
} from "../src/index.js";

const browserCookie = "soul_dashboard_auth=dashboard-token";

describe("planner routes", () => {
  it("requires browser authentication and validates the requested date", async () => {
    const provider = providerDouble();
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, { provider, resolveUser: cookieUserResolver() });
    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/planner/today?date=2026-07-14",
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(provider.getToday).not.toHaveBeenCalled();

      const invalid = await app.inject({
        method: "GET",
        url: "/api/planner/today?date=14-07-2026",
        headers: { cookie: browserCookie },
      });
      expect(invalid.statusCode).toBe(422);
      expect(provider.getToday).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns one aggregated today payload", async () => {
    const provider = providerDouble();
    vi.mocked(provider.getToday).mockResolvedValueOnce({
      daily: { page: page("daily"), blocks: [], state_vector: "" },
      projects: [page("project")],
      memo_blocks: [],
      tasks: [],
    });
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, { provider, resolveUser: cookieUserResolver() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/planner/today?date=2026-07-14",
        headers: { cookie: browserCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        daily: { page: { id: "daily" } },
        projects: [{ id: "project" }],
      });
      expect(provider.getToday).toHaveBeenCalledOnce();
      expect(provider.getToday).toHaveBeenCalledWith("2026-07-14");
    } finally {
      await app.close();
    }
  });

  it("returns a project aggregate and maps missing replica pages to 404", async () => {
    const provider = providerDouble();
    vi.mocked(provider.getProject)
      .mockResolvedValueOnce({ project: page("project"), tasks: [], documents: [] })
      .mockResolvedValueOnce(null);
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, { provider, resolveUser: cookieUserResolver() });
    try {
      const found = await app.inject({
        method: "GET",
        url: "/api/planner/projects/project",
        headers: { cookie: browserCookie },
      });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toMatchObject({ project: { id: "project" } });

      const missing = await app.inject({
        method: "GET",
        url: "/api/planner/projects/missing",
        headers: { cookie: browserCookie },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "PLANNER_PAGE_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  it("declares both aggregate routes as authenticated", () => {
    expect(plannerRouteAuthRequirements).toEqual({
      "GET /api/planner/today": true,
      "GET /api/planner/projects/{pageId}": true,
    });
  });
});

function providerDouble(): PlannerReadProvider & {
  getToday: ReturnType<typeof vi.fn>;
  getProject: ReturnType<typeof vi.fn>;
} {
  return {
    getToday: vi.fn(async () => null),
    getProject: vi.fn(async () => null),
  };
}

function cookieUserResolver() {
  return vi.fn(async (request: FastifyRequest) =>
    request.headers.cookie === browserCookie
      ? { email: "user@example.com" }
      : null);
}

function page(id: string) {
  return {
    id,
    title: id,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}
