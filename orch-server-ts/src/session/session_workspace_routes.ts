import type { FastifyInstance, FastifyReply } from "fastify";
import type { SessionWorkspaceDiffResponse, SessionWorkspaceResponse } from "@soulstream/wire-schema/session-workspace";
import { relativePath } from "./session_file_activity.js";
import { SessionResourceAccessError, type SessionResourceAccessProvider } from "./session_resource_access.js";

export type WorkspaceFile = { content_b64: string; content_type: string; size: number; offset: number; length: number };
export interface SessionWorkspaceProvider {
  readWorkspace(sessionId: string): Promise<SessionWorkspaceResponse>;
  openWorkspace(sessionId: string): Promise<{workspace:SessionWorkspaceResponse; readDiff(file:string,origPath:string|null):Promise<SessionWorkspaceDiffResponse>; readFile(file:string,offset:number,length?:number):Promise<WorkspaceFile>}>;
}
export class WorkspaceRouteError extends Error { constructor(public readonly statusCode: number, message: string) { super(message); } }
export type SessionWorkspaceRouteOptions = { provider: SessionWorkspaceProvider; accessProvider: Pick<SessionResourceAccessProvider, "requireSessionAccess" | "resolveAccess"> };
export const sessionWorkspaceRouteAuthRequirements = { "GET /api/sessions/:session_id/workspace": true, "GET /api/sessions/:session_id/workspace/file": true, "GET /api/sessions/:session_id/workspace/diff": true } as const;
export function registerSessionWorkspaceRoutes(app: FastifyInstance, options: SessionWorkspaceRouteOptions): void {
  app.get("/api/sessions/:session_id/workspace", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {session_id} = request.params as {session_id:string};
    try { await options.accessProvider.requireSessionAccess({request,sessionId:session_id}); const access=await options.accessProvider.resolveAccess({request}); return filterWorkspace(await options.provider.readWorkspace(session_id),access.restricted); }
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
      const {file,opened}=await authorizedFile(options,request,session_id,query.path);
      const result=await opened.readFile(file,offset,length);
      if(range !== undefined && offset >= result.size) { reply.header("Content-Range",`bytes */${result.size}`); throw new WorkspaceRouteError(416,"range outside file"); }
      const bytes=Buffer.from(result.content_b64,"base64");
      reply.header("Content-Type",result.content_type).header("Content-Length",bytes.length).header("Accept-Ranges","bytes");
      if(query.download === "true") reply.header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(query.path.split(/[\\/]/).pop() ?? "file")}`);
      if(range !== undefined) reply.code(206).header("Content-Range",`bytes ${result.offset}-${result.offset+result.length-1}/${result.size}`);
      return reply.send(bytes);
    } catch(error) { return sendError(reply,error); }
  });
  app.get("/api/sessions/:session_id/workspace/diff", async (request,reply) => {
    reply.header("Cache-Control", "private, no-store");
    const {session_id}=request.params as {session_id:string};
    try {
      await options.accessProvider.requireSessionAccess({request,sessionId:session_id});
      const query=request.query as {path?:unknown};
      if(typeof query.path !== "string" || !query.path) throw new WorkspaceRouteError(400,"path is required");
      const {file,origPath,opened}=await authorizedFile(options,request,session_id,query.path);
      return await opened.readDiff(file,origPath);
    } catch(error) { return sendError(reply,error); }
  });
}
function filterWorkspace(workspace:SessionWorkspaceResponse, restricted:boolean):SessionWorkspaceResponse {
  return restricted ? {...workspace,files:workspace.files.filter(file=>file.wrote || file.read)} : workspace;
}
async function authorizedFile(options:SessionWorkspaceRouteOptions, request:import("fastify").FastifyRequest, sessionId:string, requested:string) {
  const access=await options.accessProvider.resolveAccess({request});
  const opened=await options.provider.openWorkspace(sessionId);
  const workspace=filterWorkspace(opened.workspace,access.restricted);
  const windows=!!workspace.root && (/^[a-z]:[\\/]/i.test(workspace.root) || workspace.root.startsWith("\\\\"));
  const same=(a:string,b:string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  const entries=[...workspace.files,...workspace.read_only];
  const normalized=relativePath(workspace.root,requested);
  const match=entries.find(item=>same(item.path,requested)) ?? (normalized ? entries.find(item=>same(item.path,normalized)) : undefined);
  if (!match) throw new WorkspaceRouteError(403,"file not in session workspace");
  const entry=workspace.files.find(item=>same(item.path,match.path));
  const orig=entry?.orig_path;
  const allowedOrig=orig ? entries.find(item=>same(item.path,orig))?.path ?? null : null;
  return {file:match.path,origPath:allowedOrig,opened};
}
function sendError(reply:FastifyReply,error:unknown): FastifyReply {
  if(error instanceof SessionResourceAccessError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
  if(error instanceof WorkspaceRouteError) return reply.code(error.statusCode).send({error:{code:"WORKSPACE_ERROR",message:error.message}});
  return reply.code(503).send({error:{code:"WORKSPACE_UNAVAILABLE",message:"Workspace unavailable"}});
}
