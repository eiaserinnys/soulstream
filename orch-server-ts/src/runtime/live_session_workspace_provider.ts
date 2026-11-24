import type { NodeWorkspaceSnapshot, SessionWorkspaceResponse } from "@soulstream/wire-schema/session-workspace";
import type { NodeCommandRegistryPort } from "../node/registry_types.js";
import { PendingNodeCommandRejectedError, PendingNodeCommandTimeoutError, type RequestResponseNodeCommandPayload } from "../node/pending_commands.js";
import { NodeCommandTransportError, type SessionCommandTransportBridge } from "../session/session_command_transport.js";
import { collectSessionFileActivity, type FileActivityRow } from "../session/session_file_activity.js";
import { collectSessionFileEdits } from "../session/session_file_edits.js";
import { WorkspaceRouteError, type SessionWorkspaceProvider, type WorkspaceFile } from "../session/session_workspace_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";

type SessionRow = { session_id:string; node_id:string; agent_id:string; worktree_id:string|null; created_at:Date|string; model_preset:string|null };
type Options = { sqlResolver: LiveDbSqlResolver; registry: NodeCommandRegistryPort; bridge: Pick<SessionCommandTransportBridge,"sendPendingCommand">; modelCatalog: ModelCatalogSource };
export function createLiveSessionWorkspaceProvider(options: Options): SessionWorkspaceProvider {
  const last = new Map<string, {snapshot:NodeWorkspaceSnapshot; node_id:string; agent_id:string; worktree_id:string|null}>();
  async function session(id:string):Promise<SessionRow> {
    const sql=await options.sqlResolver.resolveSql();
    const rows=await sql`SELECT session_id, node_id, agent_id, worktree_id, created_at, model_preset FROM sessions WHERE session_id = ${id}`;
    if (!rows[0]) throw new WorkspaceRouteError(404,"session not found");
    return rows[0] as SessionRow;
  }
  async function send(row:SessionRow, payload:RequestResponseNodeCommandPayload, timeoutMs:number) {
    const node=options.registry.getConnectedNode(row.node_id);
    if(!node) throw new WorkspaceRouteError(503,"node offline");
    try {
      const command=options.registry.createCommand(row.node_id,payload,{timeoutMs});
      return await options.bridge.sendPendingCommand({node,command});
    } catch(error) { throw mapError(error); }
  }
  async function workspace(sessionId:string, row:SessionRow):Promise<{listing:SessionWorkspaceResponse; activityRoot:string|null}> {
      const since = dateString(row.created_at);
      let snapshot: NodeWorkspaceSnapshot | undefined; let status:SessionWorkspaceResponse["node"]["status"]="ok";
      try {
        snapshot = await send(row,{type:"workspace_snapshot",session_id:sessionId,agent_id:row.agent_id,worktree_id:row.worktree_id,since},10_000) as unknown as NodeWorkspaceSnapshot;
        if (snapshot.state === "pending" && !snapshot.git) {
          const previous=last.get(sessionId);
          if (previous && previous.node_id === row.node_id && previous.agent_id === row.agent_id && previous.worktree_id === row.worktree_id && previous.snapshot.root === snapshot.root) snapshot={...snapshot,git:previous.snapshot.git};
        } else { last.delete(sessionId); last.set(sessionId,{snapshot,node_id:row.node_id,agent_id:row.agent_id,worktree_id:row.worktree_id}); if(last.size>200) last.delete(last.keys().next().value!); }
      } catch(error) {
        const code=error instanceof WorkspaceRouteError ? error.statusCode : 502;
        status=code === 503 ? "offline" : code === 501 ? "unsupported" : code === 404 ? "no_workspace" : "error";
        if(code !== 501 && code !== 404) { const previous=last.get(sessionId); if(previous?.node_id === row.node_id && previous.agent_id === row.agent_id && previous.worktree_id === row.worktree_id) snapshot=previous.snapshot; }
      }
      const sql=await options.sqlResolver.resolveSql();
      const rows=await sql`SELECT event_type, payload->>'tool_name' AS tool_name, MAX(created_at) AS created_at,
        payload->'tool_input'->>'file_path' AS file_path, payload->'tool_input'->>'notebook_path' AS notebook_path,
        payload->'tool_input'->>'filePath' AS file_path_camel, payload->'tool_input'->>'AbsolutePath' AS absolute_path,
        payload->'tool_input'->>'Path' AS path_arg, payload->'tool_input'->>'TargetFile' AS target_file,
        CASE WHEN event_type = 'tool_result' AND payload->>'tool_name' = 'file_change'
          THEN payload->>'result' ELSE NULL END AS result
        FROM events WHERE session_id = ${sessionId} AND (event_type = 'tool_start' OR (event_type = 'tool_result' AND payload->>'tool_name' = 'file_change'))
        GROUP BY event_type, payload->>'tool_name', payload->'tool_input'->>'file_path', payload->'tool_input'->>'notebook_path', payload->'tool_input'->>'filePath', payload->'tool_input'->>'AbsolutePath', payload->'tool_input'->>'Path', payload->'tool_input'->>'TargetFile', CASE WHEN event_type = 'tool_result' AND payload->>'tool_name' = 'file_change' THEN payload->>'result' ELSE NULL END
        ORDER BY MAX(created_at) DESC`;
      let activityRoot=snapshot?.root ?? null;
      if (!activityRoot && row.worktree_id) {
        const worktrees=await sql`SELECT canonical_path FROM worktrees WHERE id = ${row.worktree_id}`;
        activityRoot=typeof worktrees[0]?.canonical_path === "string" ? worktrees[0].canonical_path : null;
      }
      const activity=collectSessionFileActivity(activityRoot, rows as FileActivityRow[]);
      const git=snapshot?.git; const changed=new Map((git?.files ?? []).map(file=>[file.path,file]));
      const committed=new Set((git?.commits ?? []).filter(commit=>Date.parse(commit.committed_at) >= Date.parse(since)).flatMap(commit=>commit.files));
      const names=new Set([...changed.keys(), ...[...activity].filter(([,v])=>v.wrote).map(([p])=>p)]);
      const files=[...names].sort().map(file=>{
        const change=changed.get(file), act=activity.get(file);
        return {path:file,git_status:change?.status ?? null,orig_path:change?.orig_path ?? null,added:change?.added ?? null,deleted:change?.deleted ?? null,size:change?.size ?? null,wrote:act?.wrote ?? false,read:act?.read ?? false,committed:!!act?.wrote && committed.has(file),last_activity_at:act?.last_activity_at ?? null};
      });
      const read_only=[...activity].filter(([file,act])=>act.read && !act.wrote && !changed.has(file)).map(([file,act])=>({path:file,size:null,last_read_at:act.last_read_at})).sort((a,b)=>a.path.localeCompare(b.path));
      const listing:SessionWorkspaceResponse={session_id:sessionId,root:snapshot?.root ?? null,node:{id:row.node_id,status},snapshot:snapshot ? {state:snapshot.state,observed_at:snapshot.observed_at,refreshing:snapshot.refreshing,branch:git?.branch ?? null,head:git?.head ?? null,upstream:git?.upstream ?? null,ahead:git?.ahead ?? 0,behind:git?.behind ?? 0,truncated:git?.truncated ?? false} : null,attribution:options.modelCatalog.snapshot().presets.find(p=>p.id===row.model_preset)?.backend === "claude" ? "full" : "partial",files,read_only};
      return {listing,activityRoot};
  }
  return {
    async readWorkspace(sessionId) { return (await workspace(sessionId,await session(sessionId))).listing; },
    async openWorkspace(sessionId) {
      const row=await session(sessionId);
      const {listing,activityRoot}=await workspace(sessionId,row);
      return {workspace:listing,
    activityRoot,
    async readSessionDiff(file) {
      const sql=await options.sqlResolver.resolveSql();
      const events=await sql`SELECT event_type, payload, created_at FROM events WHERE session_id = ${sessionId} AND event_type IN ('tool_start', 'tool_result') AND payload->>'tool_name' IN ('Edit','MultiEdit','Write','NotebookEdit','file_change','write_file','write_to_file','edit_file','replace_file_content','multi_replace_file_content','notebook_edit','edit','write') ORDER BY id`;
      return collectSessionFileEdits(activityRoot,file,events as any);
    },
    async readDiff(file,origPath) {
      const result=await send(row,{type:"workspace_file_diff",session_id:sessionId,agent_id:row.agent_id,worktree_id:row.worktree_id,path:file,orig_path:origPath,...(listing.root === null ? {} : {expected_root:listing.root})},60_000);
      if (result.root_checked !== true) throw new WorkspaceRouteError(501,"node does not enforce workspace root");
      const diff=result as unknown as import("@soulstream/wire-schema/session-workspace").SessionWorkspaceDiffResponse;
      return {path:file,status:diff.status,text:diff.text,truncated:diff.truncated,binary:diff.binary};
    },
    async readFile(file,offset,length) {
      const result=await send(row,{type:"workspace_file_read",session_id:sessionId,agent_id:row.agent_id,worktree_id:row.worktree_id,path:file,expected_root:listing.root!,offset,...(length === undefined ? {} : {length})},60_000);
      if (result.root_checked !== true) throw new WorkspaceRouteError(501,"node does not enforce workspace root");
      return result as unknown as WorkspaceFile;
    }};
    },
  };
}
function dateString(value:Date|string):string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function mapError(error:unknown):WorkspaceRouteError {
  if(error instanceof WorkspaceRouteError) return error;
  if(error instanceof PendingNodeCommandTimeoutError) return new WorkspaceRouteError(504,error.message);
  if(error instanceof NodeCommandTransportError) return new WorkspaceRouteError(503,error.message);
  if(error instanceof PendingNodeCommandRejectedError) {
    if(error.response?.code === "CONTROL_RESULT_TIMEOUT") return new WorkspaceRouteError(504,error.message);
    if(error.response?.code === "CONTROL_COMMAND_NOT_IN_INVENTORY" || error.message.startsWith("Not implemented in soul-server-ts:")) return new WorkspaceRouteError(501,error.message);
    if(error.message.startsWith("Node disconnected:")) return new WorkspaceRouteError(503,error.message);
    for(const [prefix,code] of [["NOT_FOUND:",404],["TOO_LARGE:",413],["INVALID_REQUEST:",400],["NOT_GIT:",409],["CONFLICT:",409]] as const) if(error.message.startsWith(prefix)) return new WorkspaceRouteError(code,error.message);
  }
  return new WorkspaceRouteError(502,error instanceof Error ? error.message : String(error));
}
