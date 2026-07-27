import type { FastifyInstance } from "fastify";

import {
  requireAdmin,
  type AdminAccessProvider,
} from "../admin/admin_users_routes.js";
import type { MemoryStatsCollector } from "./memory_stats.js";

export type RuntimeMemoryRouteOptions = {
  readonly accessProvider: AdminAccessProvider;
  readonly stats: Pick<MemoryStatsCollector, "collect">;
};

export const runtimeMemoryRouteAuthRequirements = {
  "GET /api/admin/runtime-memory": true,
} as const;

export function registerRuntimeMemoryRoutes(
  app: FastifyInstance,
  options: RuntimeMemoryRouteOptions,
): void {
  app.get("/api/admin/runtime-memory", async (request, reply) => {
    const adminEmail = await requireAdmin(
      request,
      reply,
      options.accessProvider,
    );
    if (adminEmail === undefined) return reply;
    return reply.send(options.stats.collect());
  });
}
