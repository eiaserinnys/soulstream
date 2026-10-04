import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminAccessProvider } from "../admin/admin_access.js";
import type { OwnedAgentService } from "./service.js";
import { OwnedAgentError } from "./types.js";
export type OwnedAgentRouteOptions = Pick<AdminAccessProvider, "currentEmail"> & { service: OwnedAgentService };
export const ownedAgentRouteAuthRequirements = {
  "GET /api/owned-agents": true, "POST /api/owned-agents": true,
  "PATCH /api/owned-agents/:id": true, "POST /api/owned-agents/:id/keys": true,
  "DELETE /api/owned-agents/:id/keys/:keyId": true, "POST /api/owned-agents/register-existing": true,
} as const;
const name = z.string().trim().min(1);
const empty = z.object({}).strict();
export function registerOwnedAgentRoutes(app: FastifyInstance, options: OwnedAgentRouteOptions) {
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    for (const [key] of Object.entries(ownedAgentRouteAuthRequirements)) {
      if (!key.startsWith(method + " ")) continue;
      const url = key.slice(method.length + 1);
      app.route({ method, url, handler: async (request, reply) => {
        try {
          const email = (await options.currentEmail(request))?.trim().toLowerCase();
          if (!email) throw new OwnedAgentError(401, "Authentication required");
          const params = request.params as { id?: string; keyId?: string };
          if (params.id) z.uuid().parse(params.id);
          if (params.keyId) z.uuid().parse(params.keyId);
          const body = request.body ?? {};
          if (method === "GET") return await options.service.list(email);
          if (url.endsWith("register-existing")) return await options.service.registerExisting(email, z.object({ name: name.optional() }).strict().parse(body).name);
          if (method === "POST" && !params.id) {
            const input = z.object({ name }).strict().parse(body);
            reply.code(201); return { agent: await options.service.create(email, input.name) };
          }
          if (method === "PATCH") return { agent: await options.service.update(email, params.id!, z.object({ name: name.optional(), enabled: z.boolean().optional() }).strict().parse(body)) };
          if (method === "POST") { empty.parse(body); reply.code(201); return await options.service.issue(email, params.id!); }
          await options.service.revoke(email, params.id!, params.keyId!); return reply.code(204).send();
        } catch (error) {
          const status = error instanceof OwnedAgentError ? error.statusCode : error instanceof z.ZodError ? 422 : 503;
          return reply.code(status).send({ detail: error instanceof OwnedAgentError ? error.message : status === 422 ? "Invalid owned agent request" : "Owned agent storage temporarily unavailable" });
        }
      } });
    }
  }
}
