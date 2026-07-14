import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { PageBrowserUser } from "../page/page_browser_routes.js";
import type { PlannerReadProvider } from "./planner_contract.js";

export const plannerRouteAuthRequirements = {
  "GET /api/planner/today": true,
  "GET /api/planner/projects/{pageId}": true,
} as const;

export interface PlannerRouteOptions {
  provider: PlannerReadProvider;
  resolveUser: (request: FastifyRequest) => Promise<PageBrowserUser | null>;
}

const id = z.string().trim().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const todayQuery = z.object({ date });

export function registerPlannerRoutes(
  app: FastifyInstance,
  options: PlannerRouteOptions,
): void {
  app.get("/api/planner/today", async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const parsed = todayQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      const planner = await options.provider.getToday(parsed.data.date);
      return planner
        ? reply.send(planner)
        : notFound(reply, `daily page not found: ${parsed.data.date}`);
    } catch (error) {
      return failed(request, reply, error, "today");
    }
  });

  app.get<{ Params: { pageId: string } }>(
    "/api/planner/projects/:pageId",
    async (request, reply) => {
      if (!await options.resolveUser(request)) return unauthorized(reply);
      const parsed = id.safeParse(request.params.pageId);
      if (!parsed.success) return invalid(reply, parsed.error.message);
      try {
        const planner = await options.provider.getProject(parsed.data);
        return planner
          ? reply.send(planner)
          : notFound(reply, `project page not found: ${parsed.data}`);
      } catch (error) {
        return failed(request, reply, error, "project");
      }
    },
  );
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
  request.log.error({ err: error, operation }, "planner read failed");
  return reply.code(500).send({
    code: "PLANNER_READ_FAILED",
    detail: error instanceof Error ? error.message : String(error),
  });
}
