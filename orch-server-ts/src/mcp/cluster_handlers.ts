import { withVerifiedSessionOwner } from "../session/session_owner.js";
import { STATUS_CODES } from "node:http";
import { clusterTools, errorResult, jsonResult, readOrchErrorEnvelopeText, type CallToolResult } from "@soulstream/mcp-contract";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { executeNodeSnapshotRoute } from "../node/node_snapshot_routes.js";
import { executeNodeAgentProfileRoute } from "../node/node_agent_profile_routes.js";
import { executeCogitoBriefRoute } from "../cogito/cogito_routes.js";
import { executeCreateSessionRoute } from "../session/session_command_routes.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Handler = (options: McpHostOptions, args: Args, context: McpCallContext) => Promise<CallToolResult>;
type Response = { status: number; body: unknown };
class OrchHttpError extends Error {
  constructor(message: string, readonly code?: string, readonly detailMessage?: string) { super(message); }
}
async function request(method: string, path: string, run: () => Response | Promise<Response>): Promise<unknown> {
  const response = await run();
  const body = JSON.parse(JSON.stringify(response.body));
  if (response.status >= 200 && response.status < 300) return body;
  const statusText = STATUS_CODES[response.status] ?? "";
  const detail = readOrchErrorEnvelopeText({ status: response.status, statusText }, JSON.stringify(body));
  throw new OrchHttpError(`orch ${method} ${path} failed: ${response.status} ${statusText} ${detail.message}`, detail.code ?? undefined, detail.message);
}
async function run(fn: () => Promise<unknown>) {
  try { return jsonResult(await fn()); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
}
const node = (operation: "agents" | "model-presets" | "plan" | "apply" | "snapshots" | "rollback", suffix: string, method: "GET" | "POST", body: (a: Args) => Args = () => ({})): Handler => (o, a) => run(() => request(method,
  `/api/nodes/${encodeURIComponent(String(a.node_id))}/${suffix}`,
  () => executeNodeAgentProfileRoute(o.cluster.nodeAgentProfiles, operation, String(a.node_id), JSON.parse(JSON.stringify(body(a))))));
const profileBody = (a: Args) => ({ profile: a.profile, create_if_missing: a.create_if_missing ?? false, include_text_diff: a.include_text_diff ?? a.includeTextDiff ?? false });

export const clusterHandlers = {
  list_nodes: o => run(() => request("GET", "/api/nodes", async () => ({ status: 200, body: executeNodeSnapshotRoute(o.cluster.nodes) }))),
  reflect_cluster_brief: o => run(() => request("GET", "/cogito/briefs", () => executeCogitoBriefRoute(o.cluster.cogito, {}))),
  list_node_agents: node("agents", "agents", "GET"),
  list_node_model_presets: node("model-presets", "model-presets", "GET"),
  plan_remote_agent_profile_update: node("plan", "agents/config/plan-profile-update", "POST", profileBody),
  apply_remote_agent_profile_update: node("apply", "agents/config/apply-profile-update", "POST", a => ({ ...profileBody(a), expected_config_checksum: a.expected_config_checksum ?? a.expectedConfigChecksum })),
  list_remote_agents_config_snapshots: node("snapshots", "agents/config/snapshots", "GET"),
  rollback_remote_agents_config: (o, a, c) => {
    if (!a.snapshot_path && !a.snapshot_id) return Promise.resolve(errorResult("snapshot_path or snapshot_id is required"));
    return node("rollback", "agents/config/rollback", "POST", a => ({ snapshot_path: a.snapshot_path, snapshot_id: a.snapshot_id, include_text_diff: a.include_text_diff ?? a.includeTextDiff ?? false }))(o, a, c);
  },
  create_remote_agent_session: async (o, a, c) => {
    const explicit = typeof a.caller_session_id === "string" ? a.caller_session_id.trim() : "";
    const callerSessionId = c.principal === "external" ? undefined : explicit || c.callerSessionId || undefined;
    if (c.principal !== "external" && !callerSessionId) return errorResult("caller_session_id is required for create_remote_agent_session. Pass the current soulstream_session.agent_session_id or send x-soulstream-agent-session-id.");
    const body: Args = { prompt: a.prompt, nodeId: a.node_id };
    if (a.agent_id !== undefined) body.profile = a.agent_id;
    if (a.model_preset !== undefined) body.model_preset = a.model_preset;
    if (a.reasoning_effort !== undefined) body.reasoningEffort = a.reasoning_effort;
    // Explicit null also wins; a lookup failure has always meant no inherited folder.
    let folderId: unknown = null;
    if (Object.hasOwn(a, "folder_id") && a.folder_id !== undefined) folderId = a.folder_id ?? null;
    else if (callerSessionId) {
      try { folderId = (await o.cluster.readSession(callerSessionId))?.folder_id ?? null; }
      catch (error) { o.cluster.logger.warn({ err: error, callerSessionId }, "caller session folder lookup failed"); }
    }
    body.folderId = folderId;
    if (a.card_id !== undefined) body.cardId = a.card_id;
    if (a.notify_completion !== undefined) body.notify_completion = a.notify_completion;
    // resolveStructuralCallerSessionId retains the caller even for notify_completion=false.
    if (callerSessionId) body.caller_session_id = callerSessionId;
    if (callerSessionId && o.resolveSessionOwner) {
      if (explicit && c.callerSessionId && explicit !== c.callerSessionId) return errorResult("caller_session_id does not match authenticated session");
      try { body.caller_info = withVerifiedSessionOwner(c.callerInfo, await o.resolveSessionOwner(callerSessionId)); }
      catch { return errorResult("Durable caller identity temporarily unavailable"); }
    } else body.caller_info = c.callerInfo;
    try { return jsonResult(await request("POST", "/api/sessions", () => executeCreateSessionRoute(o.cluster.sessions, SERVICE_CALLER, JSON.parse(JSON.stringify(body)), o.cluster.logger))); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(error instanceof OrchHttpError && error.code === "MODEL_PRESET_NOT_FOUND"
        ? `${error.detailMessage ?? message}. Call list_node_model_presets with node_id '${a.node_id}' to list valid preset ids.` : message);
    }
  },
} satisfies Record<keyof typeof clusterTools, Handler>;
