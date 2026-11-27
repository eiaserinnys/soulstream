import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminAccessProvider } from "./admin_access.js";
import { AntigravityBackendError, type AntigravityBackendSettings } from "../settings/antigravity_backend_settings.js";

export type AntigravityBackendRoutes = AdminAccessProvider & {
  service: Pick<AntigravityBackendSettings, "get" | "put">;
};
export const antigravityBackendRouteAuthRequirements = {
  "GET /api/admin/settings/antigravity-backend": true,
  "PUT /api/admin/settings/antigravity-backend": true,
} as const;
export function registerAntigravityBackendRoutes(app: FastifyInstance, options: AntigravityBackendRoutes): void {
  for (const method of ["GET", "PUT"] as const) {
    app.route({ method, url: "/api/admin/settings/antigravity-backend", handler: async (request, reply) => {
      const email = await requireAdmin(request, reply, options);
      if (!email) return reply;
      try {
        if (method === "GET") return await options.service.get();
        const body = request.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new AntigravityBackendError(422, "ANTIGRAVITY_BACKEND_INVALID", "Request body must be an object");
        return await options.service.put({ value: body.value, expectedVersion: body.expectedVersion as number, updatedBy: email });
      } catch (error) {
        if (!(error instanceof AntigravityBackendError)) throw error;
        return reply.code(error.statusCode).send({ detail: { error: { code: error.code, message: error.message } } });
      }
    } });
  }
}
