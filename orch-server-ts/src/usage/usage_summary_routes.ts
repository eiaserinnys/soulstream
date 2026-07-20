import type { FastifyInstance } from "fastify";

import type { UsageSummaryService } from "./usage_summary_service.js";

export type UsageSummaryRouteOptions = {
  readonly service: Pick<UsageSummaryService, "getSummary">;
};

export const usageSummaryRouteAuthRequirements = {
  "GET /api/usage/summary": true,
} as const;

export function registerUsageSummaryRoutes(
  app: FastifyInstance,
  options: UsageSummaryRouteOptions,
): void {
  app.get("/api/usage/summary", async () => options.service.getSummary());
}
