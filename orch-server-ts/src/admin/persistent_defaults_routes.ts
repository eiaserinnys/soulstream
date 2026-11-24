import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminAccessProvider } from "./admin_access.js";
import { PersistentDefaultsError, type PersistentDefaultsSettings } from "../settings/persistent_defaults_settings.js";

export type PersistentDefaultsRoutes = AdminAccessProvider & {
  service: Pick<PersistentDefaultsSettings, "get" | "put">;
  resolveCaller(sessionId: string): Promise<{ ownerEmail: string; purpose?: string | null } | null>;
};
export const persistentDefaultsRouteAuthRequirements = {
  "GET /api/admin/settings/persistent-defaults": true,
  "PUT /api/admin/settings/persistent-defaults": true,
} as const;
export function registerPersistentDefaultsRoutes(app: FastifyInstance, options: PersistentDefaultsRoutes): void {
  for (const method of ["GET", "PUT"] as const) {
    app.route({ method, url: "/api/admin/settings/persistent-defaults", handler: async (request, reply) => {
      const email = await requireAdmin(request, reply, options);
      if (!email) return reply;
      try {
        if (method === "GET") return await options.service.get();
        const body = request.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new PersistentDefaultsError(422, "PERSISTENT_DEFAULTS_INVALID", "Request body must be an object");
        return await options.service.put({ value: body.value, expectedVersion: body.expectedVersion as number, updatedBy: email });
      } catch (error) {
        if (!(error instanceof PersistentDefaultsError)) throw error;
        return reply.code(error.statusCode).send({ detail: { error: { code: error.code, message: error.message } } });
      }
    } });
  }
}
