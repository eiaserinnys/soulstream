import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminAccessProvider } from "./admin_access.js";
import { SummarySettingsError, type SummarySettings } from "../settings/summary_settings.js";

export type SummarySettingsRoutes = AdminAccessProvider & {
  service: Pick<SummarySettings, "get" | "put">;
};
export const summarySettingsRouteAuthRequirements = {
  "GET /api/admin/settings/summaries": true,
  "PUT /api/admin/settings/summaries": true,
} as const;
export function registerSummarySettingsRoutes(app: FastifyInstance, options: SummarySettingsRoutes): void {
  for (const method of ["GET", "PUT"] as const) {
    app.route({ method, url: "/api/admin/settings/summaries", handler: async (request, reply) => {
      const email = await requireAdmin(request, reply, options);
      if (!email) return reply;
      try {
        if (method === "GET") return await options.service.get();
        const body = request.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new SummarySettingsError(400, "SUMMARY_SETTINGS_INVALID", "Request body must be an object");
        return await options.service.put({ value: body.value, expectedVersion: body.expectedVersion as number, updatedBy: email });
      } catch (error) {
        if (!(error instanceof SummarySettingsError)) throw error;
        return reply.code(error.statusCode).send({ detail: { error: { code: error.code, message: error.message } } });
      }
    } });
  }
}
