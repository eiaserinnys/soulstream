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
    registerPlannerRoutes(app, {
      provider,
      dailyPages: dailyPageServiceDouble(),
      resolveUser: cookieUserResolver(),
    });
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
      review_session_ids: ["review-session"],
    });
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, {
      provider,
      dailyPages: dailyPageServiceDouble(),
      resolveUser: cookieUserResolver(),
    });
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
        review_session_ids: ["review-session"],
      });
      expect(provider.getToday).toHaveBeenCalledOnce();
      expect(provider.getToday).toHaveBeenCalledWith("2026-07-14");
    } finally {
      await app.close();
    }
  });

  it("lazily creates a missing daily page once before returning the aggregate", async () => {
    const provider = providerDouble();
    vi.mocked(provider.getToday)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        daily: { page: page("daily"), blocks: [], state_vector: "" },
        projects: [],
        memo_blocks: [],
        tasks: [],
        review_session_ids: [],
      });
    const dailyPages = {
      getDailyPage: vi.fn().mockResolvedValue({
        page: page("daily"),
        created: true,
      }),
    };
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, {
      provider,
      dailyPages,
      resolveUser: cookieUserResolver(),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/planner/today?date=2026-07-17",
        headers: { cookie: browserCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ daily: { page: { id: "daily" } } });
      expect(dailyPages.getDailyPage).toHaveBeenCalledOnce();
      expect(dailyPages.getDailyPage).toHaveBeenCalledWith({
        date: "2026-07-17",
        actor: { actorKind: "user", actorUserId: "user@example.com" },
      });
      expect(provider.getToday).toHaveBeenCalledTimes(2);
      expect(provider.getToday).toHaveBeenNthCalledWith(1, "2026-07-17");
      expect(provider.getToday).toHaveBeenNthCalledWith(2, "2026-07-17");
    } finally {
      await app.close();
    }
  });

  it("returns a project aggregate and maps missing replica pages to 404", async () => {
    const provider = providerDouble();
    vi.mocked(provider.getProject)
      .mockResolvedValueOnce({
        project: page("project"),
        tasks: { items: [], next_cursor: null },
        documents: { items: [], next_cursor: null },
      })
      .mockResolvedValueOnce(null);
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, {
      provider,
      dailyPages: dailyPageServiceDouble(),
      resolveUser: cookieUserResolver(),
    });
    try {
      const found = await app.inject({
        method: "GET",
        url: "/api/planner/projects/project",
        headers: { cookie: browserCookie },
      });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toMatchObject({ project: { id: "project" } });
      expect(provider.getProject).toHaveBeenNthCalledWith(1, "project", { limit: 20 });

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

  it("serves bounded starred tasks, daily history, project slices, and lazy task runs", async () => {
    const provider = providerDouble();
    vi.mocked(provider.getStarredTasks).mockResolvedValueOnce({
      items: [page("task")],
      next_cursor: "task-next",
    });
    vi.mocked(provider.getDailyHistory).mockResolvedValueOnce({
      dates: ["2026-07-13", "2026-07-11"],
    });
    vi.mocked(provider.getProjectTasks).mockResolvedValueOnce({
      items: [],
      next_cursor: "task-next",
    });
    vi.mocked(provider.getProjectDocuments).mockResolvedValueOnce({
      items: [page("document")],
      next_cursor: null,
    });
    vi.mocked(provider.getTaskRuns).mockResolvedValueOnce({
      items: [{ agent_session_id: "session-a" }],
      next_cursor: "run-next",
      total: 61,
    });
    const app = Fastify({ logger: false });
    registerPlannerRoutes(app, {
      provider,
      dailyPages: dailyPageServiceDouble(),
      resolveUser: cookieUserResolver(),
    });
    try {
      const headers = { cookie: browserCookie };
      const [starred, history, tasks, documents, runs] = await Promise.all([
        app.inject({ method: "GET", url: "/api/planner/starred-tasks?cursor=task-cursor&limit=25", headers }),
        app.inject({ method: "GET", url: "/api/planner/daily-history?before=2026-07-14&limit=2", headers }),
        app.inject({ method: "GET", url: "/api/planner/projects/project/tasks?cursor=task-cursor&limit=10", headers }),
        app.inject({ method: "GET", url: "/api/planner/projects/project/documents?limit=8", headers }),
        app.inject({ method: "GET", url: "/api/planner/tasks/task/runs?cursor=run-cursor&limit=20", headers }),
      ]);

      expect(starred.json()).toMatchObject({ next_cursor: "task-next" });
      expect(history.json()).toEqual({ dates: ["2026-07-13", "2026-07-11"] });
      expect(tasks.json()).toMatchObject({ next_cursor: "task-next" });
      expect(documents.json()).toMatchObject({ items: [{ id: "document" }] });
      expect(runs.json()).toMatchObject({ total: 61, next_cursor: "run-next" });
      expect(provider.getStarredTasks).toHaveBeenCalledWith({ cursor: "task-cursor", limit: 25 });
      expect(provider.getDailyHistory).toHaveBeenCalledWith({ before: "2026-07-14", limit: 2 });
      expect(provider.getProjectTasks).toHaveBeenCalledWith("project", { cursor: "task-cursor", limit: 10 });
      expect(provider.getProjectDocuments).toHaveBeenCalledWith("project", { cursor: undefined, limit: 8 });
      expect(provider.getTaskRuns).toHaveBeenCalledWith("task", { cursor: "run-cursor", limit: 20 });
    } finally {
      await app.close();
    }
  });

  it("declares every planner read route as authenticated", () => {
    expect(plannerRouteAuthRequirements).toEqual({
      "GET /api/planner/today": true,
      "GET /api/planner/starred-tasks": true,
      "GET /api/planner/daily-history": true,
      "GET /api/planner/projects/{pageId}": true,
      "GET /api/planner/projects/{pageId}/tasks": true,
      "GET /api/planner/projects/{pageId}/documents": true,
      "GET /api/planner/tasks/{pageId}/runs": true,
    });
  });
});

function providerDouble(): PlannerReadProvider & {
  getToday: ReturnType<typeof vi.fn>;
  getProject: ReturnType<typeof vi.fn>;
  getStarredTasks: ReturnType<typeof vi.fn>;
  getDailyHistory: ReturnType<typeof vi.fn>;
  getProjectTasks: ReturnType<typeof vi.fn>;
  getProjectDocuments: ReturnType<typeof vi.fn>;
  getTaskRuns: ReturnType<typeof vi.fn>;
} {
  return {
    getToday: vi.fn(async () => null),
    getProject: vi.fn(async () => null),
    getStarredTasks: vi.fn(async () => ({ items: [], next_cursor: null })),
    getDailyHistory: vi.fn(async () => ({ dates: [] })),
    getProjectTasks: vi.fn(async () => null),
    getProjectDocuments: vi.fn(async () => null),
    getTaskRuns: vi.fn(async () => null),
  };
}

function dailyPageServiceDouble() {
  return {
    getDailyPage: vi.fn().mockResolvedValue({
      page: page("daily"),
      created: false,
    }),
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
