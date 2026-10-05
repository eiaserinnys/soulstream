import { randomUUID } from "node:crypto";
import { z } from "zod";
import { allowed } from "./card_route_body.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
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
  ["POST","/api/cards/:id/items/:itemId/confirm","confirm_card_item"],
  ["POST","/api/cards/:id/questions","ask_card_question"],
  ["POST","/api/cards/:id/questions/:qid/answer","answer_card_question"],
];
export const cardRouteAuthRequirements:Record<string,boolean>=Object.fromEntries([
  ...mutations.map(([method,path])=>[`${method} ${path}`,true]),
  ["POST /api/cards/:id/execute",true],["GET /api/cards/:id/execution",true],["POST /api/cards/:id/execution-settings",true],
  ["GET /api/cards",true],["GET /api/cards/:id",true],["GET /api/cards/:id/reports",true],
]);
export function registerCardRoutes(app: FastifyInstance, options: FolderRouteOptions) {
  const mutation=z.object({expectedVersion:z.number().int().positive(),idempotencyKey:z.string().min(1)}).strict();
  const confirmBody=z.object({confirmed:z.boolean(),idempotencyKey:z.string().min(1).optional()}).strict();
  const confirmItemId=z.string().regex(/^[1-9][0-9]*$/).transform(Number).refine(Number.isSafeInteger);
  const settings=mutation.extend({folderId:z.string().min(1),nodeId:z.string().nullable(),agentId:z.string().nullable(),modelPreset:z.string().nullable()});
  for(const operation of ['execute','execution','execution-settings'] as const){
    app.route<{Params:{id:string};Querystring:{requestId?:string}}>({method:operation==='execution'?'GET':'POST',url:`/api/cards/:id/${operation}`,handler:async(request,reply)=>{
      try{
        const service=await options.cardServiceProvider!();
        const detail=await service.getCard(request.params.id);
        if(!detail)throw Object.assign(new Error("Card not found"),{statusCode:404});
        await allowed(options,()=>options.accessProvider.resolveAccess(request),detail.card.folder_id);
        const actor=await cardActor(request,options);
        if(actor.actorKind!=='user')throw Object.assign(new Error("사용자 실행 경로입니다."),{statusCode:403});
        if(operation==='execution-settings'){
          const body=settings.parse(request.body);
          await allowed(options,()=>options.accessProvider.resolveAccess(request),body.folderId);
          await service.saveExecutionSettings({...body,...actor,cardId:request.params.id});
          return {card:serializeCardRow((await service.getCard(request.params.id))!.card)};
        }
        if(!options.cardExecutionServiceProvider)throw Object.assign(new Error("Card execution unavailable"),{statusCode:503});
        const executor=await options.cardExecutionServiceProvider();
        const result=operation==='execute'?await executor.execute({...mutation.parse(request.body),...actor,cardId:request.params.id})
          :await executor.observe(request.params.id,z.string().min(1).parse(request.query.requestId),actor);
        return reply.code(result.execution.state==='pending'?202:200).send({...result,card:serializeCardRow(result.card)});
      }catch(error){const failure=cardRouteErrorResponse(error);return reply.code(failure.status).send(failure.body);}
    }});
  }
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
    app.route<{ Params: { id?: string; qid?: string; itemId?: string } }>({ method, url, handler: async (request, reply) => {
      try {
        const confirm=operation === "confirm_card_item";
        const parsedConfirm=confirm ? confirmBody.parse(request.body) : undefined;
        const body=confirm ? { ...parsedConfirm!,idempotencyKey:parsedConfirm!.idempotencyKey ?? randomUUID() } : request.body;
        const itemId=confirm ? confirmItemId.parse(request.params.itemId) : undefined;
        const result = await mutateCardRouteBody(options, operation, request.params.id,
          body, () => options.accessProvider.resolveAccess(request), () => cardActor(request, options), request.params.qid, itemId);
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
