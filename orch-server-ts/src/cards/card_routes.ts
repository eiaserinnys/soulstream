import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FolderRouteOptions } from "../folders/folder_routes.js";
import { dashboardFolderActor } from "../folders/folder_workspace_routes.js";
import type { CardOperation } from "./card_operations.js";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import { listCardRouteBody, readCardRouteBody, mutateCardRouteBody, cardRouteErrorResponse } from "./card_route_body.js";

const mutations:readonly ["POST" | "PATCH",string,CardOperation][]=[
  ["POST","/api/cards","create_card"],["PATCH","/api/cards/:id","update_card"],
  ["POST","/api/cards/:id/start-work","start_card_work"],
  ["POST","/api/cards/:id/status","set_card_status"],["POST","/api/cards/:id/move","move_card"],
  ["POST","/api/cards/:id/queue-position","reorder_card_queue"],["POST","/api/cards/:id/reports","add_card_report"],
  ["POST","/api/cards/:id/comments","add_card_comment"],
  ["POST","/api/cards/:id/questions","ask_card_question"],
  ["POST","/api/cards/:id/questions/:qid/answer","answer_card_question"],
];
export const cardRouteAuthRequirements:Record<string,boolean>=Object.fromEntries([
  ...mutations.map(([method,path])=>[`${method} ${path}`,true]),
  ["GET /api/cards",true],["GET /api/cards/:id",true],["GET /api/cards/:id/reports",true],
]);
export function registerCardRoutes(app: FastifyInstance, options: FolderRouteOptions) {
  app.get<{ Querystring: { folderId?: string; status?: string } }>("/api/cards", async (request, reply) => {
    try { return await listCardRouteBody(options, request.query, () => options.accessProvider.resolveAccess(request)); }
    catch (error) { const failure = cardRouteErrorResponse(error); return reply.code(failure.status).send(failure.body); }
  });
  for (const reports of [false, true]) {
    app.get<{ Params: { id: string } }>(`/api/cards/:id${reports ? "/reports" : ""}`, async (request, reply) => {
      try { return await readCardRouteBody(options, request.params.id, () => options.accessProvider.resolveAccess(request), reports); }
      catch (error) { const failure = cardRouteErrorResponse(error); return reply.code(failure.status).send(failure.body); }
    });
  }
  for (const [method, url, operation] of mutations) {
    app.route<{ Params: { id?: string; qid?: string } }>({ method, url, handler: async (request, reply) => {
      try {
        const result = await mutateCardRouteBody(options, operation, request.params.id,
          request.body, () => options.accessProvider.resolveAccess(request), () => cardActor(request, options), request.params.qid);
        return reply.code(result.status).send(result.body);
      } catch (error) { const failure = cardRouteErrorResponse(error); return reply.code(failure.status).send(failure.body); }
    } });
  }
}

async function cardActor(request: FastifyRequest, options: FolderRouteOptions) {
  const sessionId = request.headers["x-soulstream-agent-session-id"];
  if (typeof sessionId === "string" && sessionId) {
    const verification = verifyServiceBearerAuthorization(request.headers.authorization, options.authBearerToken ?? "", options.environment);
    if (!verification.ok) throw Object.assign(new Error("Trusted service authorization required"), { statusCode: verification.statusCode });
    return { actorKind: "agent" as const, actorSessionId: sessionId };
  }
  return await dashboardFolderActor(request, options);
}
