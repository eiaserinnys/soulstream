import type { FastifyInstance, FastifyReply } from "fastify";
import type { SessionWorkspaceResponse } from "@soulstream/wire-schema/session-workspace";
import { SessionResourceAccessError, type SessionResourceAccessProvider } from "./session_resource_access.js";

export type WorkspaceFile = { content_b64: string; content_type: string; size: number; offset: number; length: number };
export interface SessionWorkspaceProvider {
  readWorkspace(sessionId: string): Promise<SessionWorkspaceResponse>;
  readFile(sessionId: string, file: string, offset: number, length?: number): Promise<WorkspaceFile>;
}
export class WorkspaceRouteError extends Error { constructor(public readonly statusCode: number, message: string) { super(message); } }
export type SessionWorkspaceRouteOptions = { provider: SessionWorkspaceProvider; accessProvider: Pick<SessionResourceAccessProvider, "requireSessionAccess"> };
export const sessionWorkspaceRouteAuthRequirements = { "GET /api/sessions/:session_id/workspace": true, "GET /api/sessions/:session_id/workspace/file": true } as const;
export function registerSessionWorkspaceRoutes(app: FastifyInstance, options: SessionWorkspaceRouteOptions): void {
  app.get("/api/sessions/:session_id/workspace", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {session_id} = request.params as {session_id:string};
    try { await options.accessProvider.requireSessionAccess({request,sessionId:session_id}); return await options.provider.readWorkspace(session_id); }
    catch(error) { return sendError(reply,error); }
  });
  app.get("/api/sessions/:session_id/workspace/file", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {session_id} = request.params as {session_id:string};
    try {
      await options.accessProvider.requireSessionAccess({request,sessionId:session_id});
      const query = request.query as {path?:unknown; download?:unknown};
      if (typeof query.path !== "string" || !query.path) throw new WorkspaceRouteError(400,"path is required");
      const range=request.headers.range; let offset=0; let length: number | undefined;
      if(range !== undefined) {
        const m=/^bytes=(\d+)-(\d*)$/.exec(range); if(!m) throw new WorkspaceRouteError(400,"invalid Range");
        offset=Number(m[1]); const end=m[2] ? Number(m[2]) : undefined;
        if(!Number.isSafeInteger(offset) || (end !== undefined && (!Number.isSafeInteger(end) || end < offset))) throw new WorkspaceRouteError(400,"invalid Range");
        if(end !== undefined) length=end-offset+1;
      }
      const result=await options.provider.readFile(session_id,query.path,offset,length);
      if(range !== undefined && offset >= result.size) { reply.header("Content-Range",`bytes */${result.size}`); throw new WorkspaceRouteError(416,"range outside file"); }
      const bytes=Buffer.from(result.content_b64,"base64");
      reply.header("Content-Type",result.content_type).header("Content-Length",bytes.length).header("Accept-Ranges","bytes");
      if(query.download === "true") reply.header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(query.path.split(/[\\/]/).pop() ?? "file")}`);
      if(range !== undefined) reply.code(206).header("Content-Range",`bytes ${result.offset}-${result.offset+result.length-1}/${result.size}`);
      return reply.send(bytes);
    } catch(error) { return sendError(reply,error); }
  });
}
function sendError(reply:FastifyReply,error:unknown): FastifyReply {
  if(error instanceof SessionResourceAccessError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
  if(error instanceof WorkspaceRouteError) return reply.code(error.statusCode).send({error:{code:"WORKSPACE_ERROR",message:error.message}});
  return reply.code(503).send({error:{code:"WORKSPACE_UNAVAILABLE",message:"Workspace unavailable"}});
}
