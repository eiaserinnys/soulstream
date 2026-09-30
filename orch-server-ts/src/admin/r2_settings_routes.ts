import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminAccessProvider } from "./admin_access.js";
import { R2_PURPOSES, R2SettingsError, r2SettingsMetadata, type R2Purpose, type R2Settings, type R2SettingsUpdate } from "../system/r2_settings.js";
import type { R2CheckResult } from "../runtime/r2_storage_resolver.js";

export type R2SettingsProvider = AdminAccessProvider & {
  getSettings: (purpose: R2Purpose) => Promise<R2Settings>;
  updateSettings: (purpose: R2Purpose, input: R2SettingsUpdate) => Promise<R2Settings>;
  check: (purpose: R2Purpose) => Promise<R2CheckResult>;
};
export const r2SettingsRouteAuthRequirements = Object.fromEntries(R2_PURPOSES.flatMap(purpose => [
  [`GET /api/admin/settings/${purpose}-r2`, true],
  [`PUT /api/admin/settings/${purpose}-r2`, true],
  [`POST /api/admin/settings/${purpose}-r2/check`, true],
]));
export function registerR2SettingsRoutes(app: FastifyInstance, provider: R2SettingsProvider): void {
  for (const purpose of R2_PURPOSES) {
    const url = `/api/admin/settings/${purpose}-r2`;
    app.get(url, async (request, reply) => {
      if (await requireAdmin(request, reply, provider) === undefined) return reply;
      try { return r2SettingsMetadata(await provider.getSettings(purpose)); }
      catch (error) { return safeError(reply, error); }
    });
    app.put(url, {
      errorHandler: (_error, _request, reply) => reply.code(400).send({ detail: { error: {
        code: "R2_SETTINGS_INVALID", message: "Invalid storage settings request.",
      } } }),
    }, async (request, reply) => {
      const email = await requireAdmin(request, reply, provider);
      if (email === undefined) return reply;
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)
        || !["endpoint", "bucket", "accessKeyId"].every(key => typeof body[key] === "string")
        || (body.secretAccessKey !== undefined && typeof body.secretAccessKey !== "string")
        || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        return safeError(reply, new R2SettingsError(422, "R2_SETTINGS_INVALID", "Supply endpoint, bucket, accessKeyId and a positive expectedVersion; secretAccessKey is optional."));
      }
      try {
        return r2SettingsMetadata(await provider.updateSettings(purpose, {
          endpoint: body.endpoint as string, bucket: body.bucket as string, accessKeyId: body.accessKeyId as string,
          ...(body.secretAccessKey === undefined ? {} : { secretAccessKey: body.secretAccessKey as string }),
          expectedVersion: Number(body.expectedVersion), updatedBy: email,
        }));
      } catch (error) { return safeError(reply, error); }
    });
    app.post(`${url}/check`, async (request, reply) => {
      if (await requireAdmin(request, reply, provider) === undefined) return reply;
      try { return await provider.check(purpose); }
      catch (error) { return safeError(reply, error); }
    });
  }
}
function safeError(reply: import("fastify").FastifyReply, error: unknown) {
  const known = error instanceof R2SettingsError ? error : new R2SettingsError(503, "R2_SETTINGS_UNAVAILABLE", "Storage settings are unavailable.");
  return reply.code(known.statusCode).send({ detail: { error: { code: known.code, message: known.message } } });
}
