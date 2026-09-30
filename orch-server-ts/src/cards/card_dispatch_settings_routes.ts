import type { FastifyInstance } from "fastify";
import { requireAdmin, type AdminAccessProvider } from "../admin/admin_access.js";
import { CardDispatchSettingsError, type CardDispatchSettings } from "./card_dispatch_settings.js";

export type CardDispatchSettingsRouteOptions = AdminAccessProvider & {
  get(): Promise<CardDispatchSettings>;
  put(input: {nodeConcurrency:unknown;expectedVersion:number;updatedBy:string}): Promise<CardDispatchSettings>;
};
export const cardDispatchSettingsRouteAuthRequirements = {
  "GET /api/settings/card-dispatch":true,"PUT /api/settings/card-dispatch":true,
} as const;
export function registerCardDispatchSettingsRoutes(app: FastifyInstance, options: CardDispatchSettingsRouteOptions): void {
  for (const method of ["GET","PUT"] as const) {
    app.route({method,url:"/api/settings/card-dispatch",handler:async(request,reply) => {
      const email = await requireAdmin(request,reply,options);
      if (!email) return reply;
      try {
        if (method === "GET") return {settings:await options.get()};
        const body=request.body as Record<string,unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CardDispatchSettingsError(422,"CARD_DISPATCH_INVALID","Request body must be a JSON object");
        return {settings:await options.put({nodeConcurrency:body.nodeConcurrency,expectedVersion:body.expectedVersion as number,updatedBy:email})};
      } catch(error) {
        if (!(error instanceof CardDispatchSettingsError)) throw error;
        return reply.code(error.statusCode).send({detail:{error:{code:error.code,message:error.message}}});
      }
    }});
  }
}
