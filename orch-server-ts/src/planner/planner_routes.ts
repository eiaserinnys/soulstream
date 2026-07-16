import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  pageBrowserUserId,
  type PageBrowserUser,
} from "../page/page_browser_routes.js";
import type { PageYjsService } from "../page/page_service.js";
import type { PlannerReadProvider } from "./planner_contract.js";
import { PlannerCursorError } from "./planner_repository_reads.js";

export const plannerRouteAuthRequirements = {
  "GET /api/planner/today": true,
  "GET /api/planner/starred-tasks": true,
  "GET /api/planner/daily-history": true,
  "GET /api/planner/projects/{pageId}": true,
  "GET /api/planner/projects/{pageId}/tasks": true,
  "GET /api/planner/projects/{pageId}/documents": true,
  "GET /api/planner/tasks/{pageId}/runs": true,
} as const;

export interface PlannerRouteOptions {
  provider: PlannerReadProvider;
  dailyPages: Pick<PageYjsService, "getDailyPage">;
  resolveUser: (request: FastifyRequest) => Promise<PageBrowserUser | null>;
}

const id = z.string().trim().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const todayQuery = z.object({ date });
const starredTasksQuery = z.object({
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const dailyHistoryQuery = z.object({
  before: date,
  limit: z.coerce.number().int().min(1).max(10).default(2),
});
const projectQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const cursorPageQuery = projectQuery.extend({ cursor: id.optional() });

export function registerPlannerRoutes(
  app: FastifyInstance,
  options: PlannerRouteOptions,
): void {
  app.get("/api/planner/today", async (request, reply) => {
    const actorUserId = pageBrowserUserId(await options.resolveUser(request));
    if (!actorUserId) return unauthorized(reply);
    const parsed = todayQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      let planner = await options.provider.getToday(parsed.data.date);
      if (!planner) {
        await options.dailyPages.getDailyPage({
          date: parsed.data.date,
          actor: { actorKind: "user", actorUserId },
        });
        planner = await options.provider.getToday(parsed.data.date);
      }
      return planner
        ? reply.send(planner)
        : notFound(reply, `daily page not found: ${parsed.data.date}`);
    } catch (error) {
      return failed(request, reply, error, "today");
    }
  });

  app.get("/api/planner/starred-tasks", async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const parsed = starredTasksQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.provider.getStarredTasks(parsed.data));
    } catch (error) {
      return failed(request, reply, error, "starred-tasks");
    }
  });

  app.get("/api/planner/daily-history", async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const parsed = dailyHistoryQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.provider.getDailyHistory(parsed.data));
    } catch (error) {
      return failed(request, reply, error, "daily-history");
    }
  });

  app.get<{ Params: { pageId: string }; Querystring: { limit?: string } }>(
    "/api/planner/projects/:pageId",
    async (request, reply) => {
      if (!await options.resolveUser(request)) return unauthorized(reply);
      const parsed = id.safeParse(request.params.pageId);
      if (!parsed.success) return invalid(reply, parsed.error.message);
      const query = projectQuery.safeParse(request.query);
      if (!query.success) return invalid(reply, query.error.message);
      try {
        const planner = await options.provider.getProject(parsed.data, query.data);
        return planner
          ? reply.send(planner)
          : notFound(reply, `project page not found: ${parsed.data}`);
      } catch (error) {
        return failed(request, reply, error, "project");
      }
    },
  );

  registerProjectSliceRoute(app, options, "tasks");
  registerProjectSliceRoute(app, options, "documents");

  app.get<{
    Params: { pageId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/planner/tasks/:pageId/runs", async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const pageId = id.safeParse(request.params.pageId);
    if (!pageId.success) return invalid(reply, pageId.error.message);
    const query = cursorPageQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.message);
    try {
      const page = await options.provider.getTaskRuns(pageId.data, query.data);
      return page
        ? reply.send(page)
        : notFound(reply, `task page not found: ${pageId.data}`);
    } catch (error) {
      return failed(request, reply, error, "task-runs");
    }
  });
}

function registerProjectSliceRoute(
  app: FastifyInstance,
  options: PlannerRouteOptions,
  kind: "tasks" | "documents",
): void {
  app.get<{
    Params: { pageId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(`/api/planner/projects/:pageId/${kind}`, async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const pageId = id.safeParse(request.params.pageId);
    if (!pageId.success) return invalid(reply, pageId.error.message);
    const query = cursorPageQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.message);
    try {
      const page = kind === "tasks"
        ? await options.provider.getProjectTasks(pageId.data, query.data)
        : await options.provider.getProjectDocuments(pageId.data, query.data);
      return page
        ? reply.send(page)
        : notFound(reply, `project page not found: ${pageId.data}`);
    } catch (error) {
      return failed(request, reply, error, `project-${kind}`);
    }
  });
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ detail: "Not authenticated" });
}

function invalid(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(422).send({ detail });
}

function notFound(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(404).send({ code: "PLANNER_PAGE_NOT_FOUND", detail });
}

function failed(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  operation: string,
): FastifyReply {
  if (error instanceof PlannerCursorError) return invalid(reply, error.message);
  request.log.error({ err: error, operation }, "planner read failed");
  return reply.code(500).send({
    code: "PLANNER_READ_FAILED",
    detail: error instanceof Error ? error.message : String(error),
  });
}
