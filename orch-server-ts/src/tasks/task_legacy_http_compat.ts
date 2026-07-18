import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { normalizeBoardAccess } from "../board/board_access.js";
import { filterTaskOverviewForAccess } from "./task_access.js";
import {
  loadTaskSnapshot,
  requireSnapshotAccess,
  sendTaskRouteError,
  taskStorageNotConfigured,
} from "./task_mutation_proxy.js";
import type { TaskRouteOptions } from "./task_route_types.js";

/** One-release HTTP read compatibility. All legacy writes fail explicitly. */
export function registerTaskLegacyHttpCompatibility(
  app: FastifyInstance,
  options: TaskRouteOptions,
): void {
  app.get("/api/runbooks/my-turn", async (request, reply) => {
    const limit = parseLegacyLimit(request.query);
    if (limit === null) {
      return reply.code(400).send({
        detail: "limit must be an integer between 1 and 500",
      });
    }
    if (options.provider.getTaskOverview === undefined) {
      return taskStorageNotConfigured(reply);
    }

    const folders = await options.provider.listFolders();
    const userId = options.resolveDashboardUserId === undefined
      ? null
      : await options.resolveDashboardUserId(request);
    const overview = await options.provider.getTaskOverview({ userId, limit });
    const access = normalizeBoardAccess(
      await options.accessProvider.resolveAccess(request),
    );
    return reply.send(
      legacyReadShape(filterTaskOverviewForAccess(overview, folders, access)),
    );
  });

  app.get<{ Params: { runbook_id: string } }>(
    "/api/runbooks/:runbook_id",
    async (request, reply) => {
      const result = await loadTaskSnapshot(
        options.provider,
        request.params.runbook_id,
      );
      if (!result.ok) return sendTaskRouteError(reply, result.error);
      const access = await requireSnapshotAccess(
        options,
        request,
        result.value,
      );
      if (!access.ok) return sendTaskRouteError(reply, access.error);
      return reply.send(legacyReadShape(result.value));
    },
  );

  const gone = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(410).send({
      detail: "Runbook mutation routes were removed; use /api/tasks.",
    });
  app.post("/api/runbooks", gone);
  app.post("/api/runbooks/*", gone);
}

function parseLegacyLimit(query: unknown): number | null {
  const values = query !== null && typeof query === "object"
    ? query as Record<string, unknown>
    : {};
  const raw = Array.isArray(values.limit) ? values.limit[0] : values.limit;
  if (raw === undefined) return 100;
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number"
    && Number.isInteger(parsed)
    && parsed >= 1
    && parsed <= 500
    ? parsed
    : null;
}

function legacyReadShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyReadShape);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const legacyKey = key === "task"
      ? "runbook"
      : key === "tasks"
        ? "runbooks"
      : key === "task_id"
        ? "runbook_id"
        : key === "taskId"
          ? "runbookId"
          : key === "task_status"
            ? "runbook_status"
            : key;
    result[legacyKey] = legacyReadShape(entry);
  }
  return result;
}
