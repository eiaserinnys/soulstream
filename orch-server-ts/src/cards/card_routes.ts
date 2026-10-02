import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { FolderRouteOptions } from "../folders/folder_routes.js";
import { filterFolders, isFolderAllowed, normalizeAccess } from "../folders/folder_route_access.js";
import { parseCardQuery } from "./completed_card_query.js";
import { dashboardFolderActor, folderOperationError } from "../folders/folder_workspace_routes.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
import { executeCardOperation, serializeCardDetail, type CardOperation } from "./card_operations.js";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";

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
export function registerCardRoutes(app:FastifyInstance,options:FolderRouteOptions) {
  app.get<{ Querystring:{ folderId?:string; status?:string } }>("/api/cards",async (request,reply)=>{
    try {
      const service=await options.cardServiceProvider!();
      const query=parseCardQuery(request.query);
      const [access,folders]=await Promise.all([options.accessProvider.resolveAccess(request),options.provider.listFolders()]);
      const normalized=normalizeAccess(access);
      const allowedFolderIds=normalized.restricted ? filterFolders(normalized,folders).map(folder=>folder.id) : null;
      if(query.status === "done") {
        const page=await service.listCompletedCards({...query,allowedFolderIds});
        return {cards:page.cards.map(serializeCardRow),nextCursor:page.nextCursor};
      }
      const cards=await service.listCards({...query,allowedFolderIds});
      return { cards:(await service.projectCards(cards)).map(serializeCardRow) };
    } catch(error) { return folderOperationError(reply,error); }
  });
  for (const reports of [false,true]) {
    app.get<{ Params:{ id:string } }>(`/api/cards/:id${reports ? "/reports" : ""}`,async (request,reply)=>{
      try {
        const detail=await (await options.cardServiceProvider!()).getCard(request.params.id);
        if (!detail) return reply.code(404).send({ detail:{ error:{ code:"CARD_NOT_FOUND" } } });
        await allowed(request,options,detail.card.folder_id);
        return reports ? { reports:detail.reports.map(serializeCardRow) } : serializeCardDetail(detail);
      } catch(error) { return folderOperationError(reply,error); }
    });
  }
  for (const [method,url,operation] of mutations) {
    app.route<{ Params:{ id?:string; qid?:string } }>({ method,url,handler:async (request,reply)=>{
      try {
        const service=await options.cardServiceProvider!();
        const body=z.record(z.string(),z.unknown()).parse(request.body);
        if (operation === "create_card") await allowed(request,options,z.string().min(1).parse(body.folderId));
        else {
          const detail=await service.getCard(request.params.id!);
          if (!detail) return reply.code(404).send({ detail:{ error:{ code:"CARD_NOT_FOUND" } } });
          await allowed(request,options,detail.card.folder_id);
        }
        if (operation === "move_card") await allowed(request,options,z.string().min(1).parse(body.folderId));
        const sessionId=request.headers["x-soulstream-agent-session-id"];
        let actor;
        if (typeof sessionId === "string" && sessionId) {
          const verification=verifyServiceBearerAuthorization(request.headers.authorization,options.authBearerToken ?? "",options.environment);
          if (!verification.ok) throw Object.assign(new Error("Trusted service authorization required"),{ statusCode:verification.statusCode });
          actor={ actorKind:"agent" as const,actorSessionId:sessionId };
        } else actor=await dashboardFolderActor(request,options);
        if (operation === "start_card_work" && actor.actorKind !== "agent") throw Object.assign(new Error("Trusted assignee session required"),{statusCode:403});
        const result=await executeCardOperation(service,operation,operation === "answer_card_question" ? { ...body,questionId:request.params.qid } : body,request.params.id,actor);
        return reply.code(operation === "create_card" || operation === "add_card_report" || operation === "add_card_comment" || operation === "ask_card_question" ? 201 : 200).send(result);
      } catch(error) { return folderOperationError(reply,error); }
    } });
  }
}
async function allowed(request:FastifyRequest,options:FolderRouteOptions,folderId:string) {
  const [access,folders]=await Promise.all([options.accessProvider.resolveAccess(request),options.provider.listFolders()]);
  if (!isFolderAllowed(normalizeAccess(access),folders,folderId)) throw Object.assign(new Error("Folder access denied"),{ statusCode:403,code:"FOLDER_ACCESS_DENIED" });
  if (folderId === "claude" || folderId === "llm") throw Object.assign(new Error("System folders cannot own cards"),{ statusCode:403 });
}
