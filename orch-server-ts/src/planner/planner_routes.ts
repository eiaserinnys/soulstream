import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  pageBrowserUserId,
  type PageBrowserUser,
} from "../page/page_browser_routes.js";
import type { PageYjsService } from "../page/page_service.js";
import { notifyPageUpdates, type PageUpdatedObserver } from "../page/page_update_notifications.js";
import {
  PLANNER_READ_PAGE_LIMITS,
  type PlannerReadProvider,
} from "./planner_contract.js";
import { PlannerCursorError } from "./planner_repository_reads.js";
import {
  PlannerStarredFolderMembershipConflictError,
  type PlannerStarredFolderOrderWriter,
} from "./planner_starred_page_order.js";

export const plannerRouteAuthRequirements = {
  "GET /api/planner/today": true,
  "GET /api/planner/starred-folders": true,
  "PATCH /api/planner/starred-folders/order": true,
  "GET /api/planner/daily-history": true,
  "GET /api/planner/folders/{folder_id}": true,
  "GET /api/planner/folders/{folder_id}/subfolders": true,
  "GET /api/planner/folders/{folder_id}/sessions": true,
} as const;

export interface PlannerRouteOptions {
  provider: PlannerReadProvider;
  starredFolderOrder: PlannerStarredFolderOrderWriter;
  onPageUpdated: PageUpdatedObserver;
  dailyPages: Pick<PageYjsService, "getDailyPage">;
  resolveUser: (request: FastifyRequest) => Promise<PageBrowserUser | null>;
}

const id = z.string().trim().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const todayQuery = z.object({ date });
const starredFoldersQuery = z.object({
  cursor: id.optional(),
  limit: pageLimit(PLANNER_READ_PAGE_LIMITS.starredFolders),
});
const starredFolderOrderBody = z.object({
  pageId: id,
  beforePageId: id.nullable(),
}).strict();
const dailyHistoryQuery = z.object({
  before: date,
  limit: pageLimit(PLANNER_READ_PAGE_LIMITS.dailyHistory),
});
const folderQuery = z.object({ limit: pageLimit(PLANNER_READ_PAGE_LIMITS.folder),
  includeCompleted: z.enum(["true","false"]).default("true").transform(value=>value === "true") });
const folderSliceQuery = cursorPageQuery(PLANNER_READ_PAGE_LIMITS.folder);

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

  app.get("/api/planner/starred-folders", async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const parsed = starredFoldersQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.provider.getStarredFolders(parsed.data));
    } catch (error) {
      return failed(request, reply, error, "starred-folders");
    }
  });

  app.patch<{ Body: { pageId: string; beforePageId: string | null } }>(
    "/api/planner/starred-folders/order",
    async (request, reply) => {
      if (!await options.resolveUser(request)) return unauthorized(reply);
      const parsed = starredFolderOrderBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({
        detail: { error: { code: "INVALID_PLANNER_STARRED_FOLDER_ORDER", message: parsed.error.message } },
      });
      if (parsed.data.pageId === parsed.data.beforePageId) return reply.code(400).send({
        detail: { error: { code: "INVALID_PLANNER_STARRED_FOLDER_ORDER", message: "source and target must differ" } },
      });
      try {
        const result = await options.starredFolderOrder.moveStarredFolder({
          pageId: parsed.data.pageId,
          beforePageId: parsed.data.beforePageId,
        });
        notifyPageUpdates(
          [{ page: { id: parsed.data.pageId, version: result.pageVersion } }],
          options.onPageUpdated,
          request.log,
        );
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof PlannerStarredFolderMembershipConflictError) {
          return reply.code(409).send({
            detail: { error: { code: error.code, message: error.message } },
          });
        }
        request.log.error({ err: error, operation: "starred-folder-order" }, "planner mutation failed");
        return reply.code(500).send({
          code: "PLANNER_MUTATION_FAILED",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

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

  app.get<{ Params: { folder_id: string } }>("/api/planner/folders/:folder_id", async (request, reply) => {
    if (!await options.resolveUser(request)) return unauthorized(reply);
    const query = folderQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.message);
    try {
      const result = await options.provider.getFolder(request.params.folder_id, query.data);
      return result ? reply.send(result) : notFound(reply, "folder not found");
    } catch (error) { return failed(request, reply, error, "folder"); }
  });
  for (const kind of ["subfolders", "sessions"] as const) {
    app.get<{ Params: { folder_id: string } }>(`/api/planner/folders/:folder_id/${kind}`, async (request, reply) => {
      if (!await options.resolveUser(request)) return unauthorized(reply);
      const query = folderSliceQuery.safeParse(request.query);
      if (!query.success) return invalid(reply, query.error.message);
      try {
        const folderId = request.params.folder_id;
        const result = kind === "subfolders" ? await options.provider.getSubfolders(folderId, query.data)
          : await options.provider.getSessions(folderId, query.data);
        return reply.send(result);
      } catch (error) { return failed(request, reply, error, kind); }
    });
  }
}

function pageLimit(limits: { default: number; max: number }) {
  return z.coerce.number().int().min(1).max(limits.max).default(limits.default);
}

function cursorPageQuery(limits: { default: number; max: number }) {
  return z.object({
    cursor: id.optional(),
    limit: pageLimit(limits),
  });
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ detail: { error: { code: "UNAUTHORIZED", message: "Not authenticated" } } });
}

function invalid(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(422).send({ detail: { error: { code: "INVALID_PLANNER_REQUEST", message: detail } } });
}

function notFound(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(404).send({ detail: { error: { code: "FOLDER_NOT_FOUND", message: detail } } });
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
