import { withVerifiedSessionOwner } from "../session/session_owner.js";
import { STATUS_CODES } from "node:http";
import { clusterTools, errorResult, jsonResult, readOrchErrorEnvelopeText, type CallToolResult } from "@soulstream/mcp-contract";
import { isRecord } from "@soulstream/wire-schema/json-record";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { executeNodeSnapshotRoute } from "../node/node_snapshot_routes.js";
import { executeNodeAgentProfileRoute } from "../node/node_agent_profile_routes.js";
import {
  AgentProfileVersionConflictError,
  loadContextBundlesById,
  parseAgentProfilePatch,
  resolveAgentProfileWrite,
  unknownContextBundles,
  type AgentProfilePatch,
  type AgentProfileRecord,
} from "../node/agent_profile_routes.js";
import { executeCogitoBriefRoute } from "../cogito/cogito_routes.js";
import { executeCreateSessionRoute } from "../session/session_command_routes.js";
import { projectModelPresets } from "./model_preset_projection.js";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";
import type {
  EventIngressDeadLetterListInput,
  EventIngressDeadLetterListState,
} from "../node/event_ingress_dead_letter_store.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Handler = (options: McpHostOptions, args: Args, context: McpCallContext) => Promise<CallToolResult>;
type Response = { status: number; body: unknown };
class OrchHttpError extends Error {
  constructor(message: string, readonly code?: string, readonly detailMessage?: string, readonly errorDetail?: Record<string, unknown>) { super(message); }
}
/** The flat error record orch sent, regardless of the envelope shape. */
function readErrorDetail(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const envelope = isRecord(body.detail) ? body.detail : body;
  return isRecord(envelope.error) ? envelope.error : envelope;
}
async function request(method: string, path: string, run: () => Response | Promise<Response>): Promise<unknown> {
  const response = await run();
  const body = JSON.parse(JSON.stringify(response.body));
  if (response.status >= 200 && response.status < 300) return body;
  const statusText = STATUS_CODES[response.status] ?? "";
  const detail = readOrchErrorEnvelopeText({ status: response.status, statusText }, JSON.stringify(body));
  throw new OrchHttpError(`orch ${method} ${path} failed: ${response.status} ${statusText} ${detail.message}`, detail.code ?? undefined, detail.message, readErrorDetail(body));
}
/**
 * The create route reports whether a lost create ack still produced a session
 * (card #1326). Surface that state in the tool text so callers no longer have
 * to poll list_sessions to learn the outcome.
 */
function createOutcomeSuffix(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return "";
  const agentSessionId = detail.agentSessionId;
  if (typeof agentSessionId !== "string" || agentSessionId.length === 0) return "";
  if (detail.created === false) {
    return ` Session was not created as of this check (agent_session_id=${agentSessionId}).`;
  }
  if (!Object.hasOwn(detail, "created")) {
    return ` Session creation could not be confirmed (agent_session_id=${agentSessionId}).`;
  }
  return "";
}
async function run(fn: () => Promise<unknown>) {
  try { return jsonResult(await fn()); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
}
type NodeOperation = "agents" | "model-presets" | "plan" | "apply" | "snapshots" | "rollback";
async function nodeRequest(o: McpHostOptions, a: Args, operation: NodeOperation, suffix: string, method: "GET" | "POST", body: (a: Args) => Args = () => ({})): Promise<unknown> {
  const nodeId = String(a.node_id);
  await o.cluster.sessions.router.waitForNode(nodeId);
  return request(method,
    `/api/nodes/${encodeURIComponent(nodeId)}/${suffix}`,
    async () => {
      const response = await executeNodeAgentProfileRoute(o.cluster.nodeAgentProfiles, operation, nodeId, JSON.parse(JSON.stringify(body(a))));
      if (response.status === 404) throw new Error(`노드 '${nodeId}'를 찾을 수 없거나 연결되어 있지 않습니다. list_nodes로 노드 이름을 확인하고 연결된 노드 이름으로 다시 부르세요.`);
      return response;
    });
}
const node = (operation: NodeOperation, suffix: string, method: "GET" | "POST", body?: (a: Args) => Args): Handler =>
  (o, a) => run(() => nodeRequest(o, a, operation, suffix, method, body));
const profileBody = (a: Args) => ({ profile: a.profile, create_if_missing: a.create_if_missing ?? false, include_text_diff: a.include_text_diff ?? a.includeTextDiff ?? false });

function projectCentralAgentProfile(profile: AgentProfileRecord): Record<string, unknown> {
  return {
    exists: true,
    agent_id: profile.agentId,
    name: profile.name,
    default_preset: profile.defaultPreset,
    aliases: profile.aliases,
    context_bundles: profile.contextBundles,
    atom_contexts: profile.atomContexts,
    has_portrait: profile.hasPortrait,
    version: profile.version,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

function centralProfileConflict(agentId: string, current: AgentProfileRecord | null): CallToolResult {
  if (current === null) {
    return errorResult(`Agent profile "${agentId}" does not exist; pass expected_version null to create it`, {
      code: "agent_profile_version_conflict",
    });
  }
  return errorResult(
    `Agent profile "${agentId}" changed: current version is ${current.version}. Retry with expected_version ${current.version}.`,
    { code: "agent_profile_version_conflict", details: { current_version: current.version } },
  );
}

/** 호출자가 이번에 보낸 default_preset id만 카탈로그와 견준다. 기존 행의 낡은 값은 건드리지 않는다. */
function unknownPresetIds(patch: AgentProfilePatch, modelCatalog: ModelCatalogSource): string[] {
  const known = new Set(modelCatalog.snapshot().presets.map((preset) => preset.id));
  const supplied = [
    ...(typeof patch.defaultPreset === "string" ? [patch.defaultPreset] : []),
    ...(patch.aliases ?? []).flatMap((alias) =>
      typeof alias === "string" || alias.default_preset === undefined ? [] : [alias.default_preset]),
  ];
  return supplied.filter((id) => !known.has(id));
}

export const clusterHandlers = {
  list_nodes: o => run(() => request("GET", "/api/nodes", async () => ({ status: 200, body: executeNodeSnapshotRoute(o.cluster.nodes) }))),
  reflect_cluster_brief: o => run(() => request("GET", "/cogito/briefs", () => executeCogitoBriefRoute(o.cluster.cogito, {}))),
  list_event_ingress_dead_letters: (o, a) => run(async () => {
    const eventIngress = o.cluster.eventIngress;
    if (eventIngress === undefined) throw new Error("event ingress observability is not configured");
    const input: EventIngressDeadLetterListInput = {
      state: a.state as EventIngressDeadLetterListState,
      ...(typeof a.since === "string" ? { since: a.since } : {}),
      ...(typeof a.until === "string" ? { until: a.until } : {}),
      ...(typeof a.node_id === "string" ? { nodeId: a.node_id } : {}),
      ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
      ...(typeof a.cursor === "string" ? { cursor: a.cursor } : {}),
    };
    return await eventIngress.listDeadLetters(input);
  }),
  get_event_ingress_delivery_latency: (o, a) => run(async () => {
    const deliveryLatency = o.cluster.eventIngress?.deliveryLatency;
    if (deliveryLatency === undefined) throw new Error("event ingress delivery latency is not configured");
    return await deliveryLatency({
      ...(typeof a.since === "string" ? { since: a.since } : {}),
      ...(typeof a.until === "string" ? { until: a.until } : {}),
      ...(typeof a.node_id === "string" ? { node_id: a.node_id } : {}),
    });
  }),
  list_node_agents: node("agents", "agents", "GET"),
  list_node_model_presets: (o, a) => run(async () => projectModelPresets(
    await nodeRequest(o, a, "model-presets", "model-presets", "GET"),
    { ...(Array.isArray(a.preset_ids) ? { presetIds: a.preset_ids.map(String) } : {}), detail: a.detail === true },
  )),
  get_central_agent_profile: (o, a) => run(async () => {
    const { repository } = o.cluster.centralAgentProfiles;
    if (a.agent_id === undefined) {
      const profiles = await repository.list();
      return { profiles: profiles.map((profile) => ({
        agent_id: profile.agentId,
        name: profile.name,
        default_preset: profile.defaultPreset,
        version: profile.version,
        updated_at: profile.updatedAt,
      })) };
    }
    const profile = await repository.get(String(a.agent_id));
    return profile === null ? { exists: false } : projectCentralAgentProfile(profile);
  }),
  update_central_agent_profile: async (o, a) => {
    const agentId = String(a.agent_id);
    const { repository, bundleRepository, modelCatalog } = o.cluster.centralAgentProfiles;
    const parsed = parseAgentProfilePatch(a);
    if (!parsed.ok) return errorResult(parsed.error);
    try {
      const current = parsed.value.expectedVersion === null ? null : await repository.get(agentId);
      if (parsed.value.expectedVersion !== null && current === null) {
        return centralProfileConflict(agentId, null);
      }
      const write = resolveAgentProfileWrite(agentId, parsed.value, current);
      if (!write.ok) return errorResult(write.error);
      const bundlesById = await loadContextBundlesById(bundleRepository);
      const unknownBundles = unknownContextBundles(write.value.contextBundles, bundlesById);
      if (unknownBundles.length > 0) {
        return errorResult(`unknown context bundles: ${unknownBundles.join(", ")}`);
      }
      const unknownPresets = modelCatalog === undefined ? [] : unknownPresetIds(parsed.value, modelCatalog);
      if (unknownPresets.length > 0) {
        return errorResult(`unknown model presets: ${unknownPresets.join(", ")}`, { code: "MODEL_PRESET_NOT_FOUND" });
      }
      return jsonResult(projectCentralAgentProfile(await repository.put(write.value)));
    } catch (error) {
      if (error instanceof AgentProfileVersionConflictError) {
        return centralProfileConflict(agentId, await repository.get(agentId));
      }
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
  delete_central_agent_profile: async (o, a) => {
    const agentId = String(a.agent_id);
    const { repository } = o.cluster.centralAgentProfiles;
    try {
      const deleted = await repository.delete(agentId, Number(a.expected_version));
      return deleted
        ? jsonResult({ agent_id: agentId, deleted: true })
        : errorResult(`Agent profile "${agentId}" not found`);
    } catch (error) {
      if (error instanceof AgentProfileVersionConflictError) {
        return centralProfileConflict(agentId, await repository.get(agentId));
      }
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
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
    if (c.principal !== "external" && !callerSessionId) return errorResult("create_remote_agent_session에는 caller_session_id가 필요합니다. 현재 세션의 soulstream_session.agent_session_id 값을 넘기세요.");
    const body: Args = { prompt: a.prompt, nodeId: a.node_id };
    if (a.agent_id !== undefined) body.profile = a.agent_id;
    if (a.model_preset !== undefined) body.model_preset = a.model_preset;
    if (a.model_preset_fallbacks !== undefined) body.model_preset_fallbacks = a.model_preset_fallbacks;
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
      if (error instanceof OrchHttpError && error.code === "MODEL_PRESET_NOT_FOUND") {
        return errorResult(`${error.detailMessage ?? message}. Call list_node_model_presets with node_id '${a.node_id}' to list valid preset ids.`);
      }
      return errorResult(`${message}${error instanceof OrchHttpError ? createOutcomeSuffix(error.errorDetail) : ""}`);
    }
  },
} satisfies Record<keyof typeof clusterTools, Handler>;
