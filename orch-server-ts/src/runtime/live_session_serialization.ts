import { asRecord } from "@soulstream/wire-schema/json-record";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import { readPersistentReport, type PersistentReportEntry } from "@soulstream/wire-schema/persistent-report";
import type { CallerInfo } from "@soulstream/wire-schema";
import { extractCallerInfo, hasCallerIdentity } from "@soulstream/wire-schema/caller-info";
import {
  findNodeAgentProfile,
  findRegisteredAgentProfile,
  type AgentProfileIdentityOverlay,
} from "../node/agent_profile_lookup.js";
import type { AgentPortraitUrlResolver } from "../node/agent_portrait_model.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import { normalizeSessionBindingWarnings } from "@soulstream/page-model";
import { normalizeLastChatMessage } from
  "../session/session_feed_projection.js";

export type SessionSerializationOptions = {
  readonly registry?: InMemoryNodeRegistry;
  readonly agentProfiles?: readonly AgentProfileIdentityOverlay[];
  readonly agentPortraitUrl?: AgentPortraitUrlResolver;
};

function reportProjection(row: Record<string, unknown>): PersistentReportEntry[] {
  const projected = row.persistent_report ?? row.persistentReport;
  return Array.isArray(projected) ? projected as PersistentReportEntry[] : readPersistentReport(row.metadata);
}

export type SessionBackendCatalogEntry = {
  readonly kind: "agent" | "preset";
  readonly node_id: string;
  readonly agent_id?: string;
  readonly agent_name?: string;
  readonly model_preset?: string;
  readonly backend: string;
};

export function buildSessionBackendCatalog(
  registry: InMemoryNodeRegistry | undefined,
  agentProfiles: readonly AgentProfileIdentityOverlay[] = [],
): SessionBackendCatalogEntry[] {
  if (registry === undefined) return [];
  const entries: SessionBackendCatalogEntry[] = [];
  for (const node of registry.listConnectedNodesAdvertised()) {
    for (const agentId of registeredAgentIds(node, agentProfiles)) {
      const profile = findNodeAgentProfile(node, agentId, agentProfiles);
      if (profile === undefined) continue;
      entries.push({
        kind: "agent",
        node_id: node.nodeId,
        agent_id: agentId,
        ...(typeof profile.agent.name === "string" && profile.agent.name.length > 0
          ? { agent_name: profile.agent.name }
          : {}),
        backend: profile.backend,
      });
    }
    for (const value of node.modelPresets ?? []) {
      const preset = asRecord(value);
      const id = typeof preset?.id === "string" ? preset.id : undefined;
      const backend = typeof preset?.backend === "string" ? preset.backend : undefined;
      if (!id || !backend) continue;
      entries.push({
        kind: "preset",
        node_id: node.nodeId,
        model_preset: id,
        backend,
      });
    }
  }
  return entries;
}

function registeredAgentIds(
  node: NodeConnectionSnapshot,
  agentProfiles: readonly AgentProfileIdentityOverlay[],
): Set<string> {
  const ids = new Set<string>();
  for (const value of node.agents) {
    const agent = asRecord(value);
    const id = typeof agent?.id === "string" ? agent.id : undefined;
    if (id) ids.add(id);
    const overlay = id ? agentProfiles.find((profile) => profile.agentId === id) : undefined;
    const aliases = overlay?.aliases ?? agent?.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === "string" && alias.length > 0) ids.add(alias);
      else {
        const aliasRecord = asRecord(alias);
        if (typeof aliasRecord?.id === "string" && aliasRecord.id.length > 0) {
          ids.add(aliasRecord.id);
        }
      }
    }
  }
  return ids;
}

export function serializeSessionRow(
  row: Record<string, unknown>,
  options: SessionSerializationOptions = {},
): Record<string, unknown> {
  const sessionType = firstDefined(row, "session_type", "sessionType");
  const payload: Record<string, unknown> = {
    agentSessionId: firstNonNullish(
      row,
      "session_id",
      "agent_session_id",
      "agentSessionId",
      "sessionId",
    ),
    status: row.status,
    prompt: row.prompt,
    createdAt: iso(firstDefined(row, "created_at", "createdAt")),
    updatedAt: iso(firstDefined(row, "updated_at", "updatedAt")),
    sessionType: sessionType === undefined ? "claude" : sessionType,
    lastMessage: normalizeLastChatMessage(
      firstDefined(row, "last_message", "lastMessage"),
    ),
    clientId: firstDefined(row, "client_id", "clientId"),
    metadata: row.metadata,
    persistentReport: reportProjection(row),
    displayName: firstDefined(row, "display_name", "displayName") ?? null,
    nodeId: firstDefined(row, "node_id", "nodeId") ?? null,
    folderId: firstDefined(row, "folder_id", "folderId") ?? null,
    cardId: firstDefined(row, "card_id", "cardId") ?? null,
    lastEventId: firstDefined(row, "last_event_id", "lastEventId") ?? 0,
    lastReadEventId:
      firstDefined(row, "last_read_event_id", "lastReadEventId") ?? 0,
    callerSessionId:
      firstDefined(row, "caller_session_id", "callerSessionId") ?? null,
    predecessorSessionId:
      firstDefined(row, "predecessor_session_id", "predecessorSessionId") ?? null,
    agentId: firstDefined(row, "agent_id", "agentId") ?? null,
    modelPreset:
      firstDefined(row, "model_preset", "modelPreset") ?? null,
    // Defence at the DTO boundary, not just in the list queries: `getSession`
    // returns the raw column on purpose (node hydration must tell a pre-089 NULL
    // apart from a recorded `auto`), and any row shape can reach this serializer.
    reasoningEffort: publicReasoningEffort(
      firstDefined(row, "reasoning_effort", "reasoningEffort"),
    ),
    modelLabel: null,
    model: row.model ?? null,
    agentName: firstDefined(row, "agent_name", "agentName") ?? null,
    agentPortraitUrl:
      firstDefined(row, "agent_portrait_url", "agentPortraitUrl") ?? null,
    backend: row.backend ?? null,
    userName: firstDefined(row, "user_name", "userName") ?? null,
    userPortraitUrl:
      firstDefined(row, "user_portrait_url", "userPortraitUrl") ?? null,
    reviewRequired:
      firstDefined(row, "review_required", "reviewRequired") === true,
    persistent: persistentFromMetadata(row.metadata),
    reviewState: normalizeReviewState(
      firstDefined(row, "review_state", "reviewState"),
    ),
    terminationReason:
      firstDefined(row, "termination_reason", "terminationReason") ?? null,
    terminationDetail:
      firstDefined(row, "termination_detail", "terminationDetail") ?? null,
    bindingWarnings: normalizeSessionBindingWarnings(
      firstDefined(row, "binding_warnings", "bindingWarnings"),
    ),
  };

  enrichAgent(payload, options.registry, options.agentProfiles ?? [], options.agentPortraitUrl);
  enrichModelPreset(payload, options.registry);
  const callerInfo = extractCallerInfo(row.metadata);
  if (callerInfo !== undefined) {
    const displayName = callerInfo.display_name;
    const avatarUrl = callerInfo.avatar_url;
    if (typeof displayName === "string" && displayName.length > 0) {
      payload.userName = displayName;
    }
    if (typeof avatarUrl === "string" && avatarUrl.length > 0) {
      payload.userPortraitUrl = avatarUrl;
    }
  }
  applyUserProfileFallback(payload, callerInfo, options.registry);
  return payload;
}

function persistentFromMetadata(metadata: unknown): boolean {
  if (!Array.isArray(metadata)) return false;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = asRecord(metadata[i]);
    if (entry?.type !== "persistent_session") continue;
    return asRecord(entry.value)?.enabled === true;
  }
  return false;
}

function enrichModelPreset(
  payload: Record<string, unknown>,
  registry: InMemoryNodeRegistry | undefined,
): void {
  const modelPreset = payload.modelPreset;
  const nodeId = payload.nodeId;
  if (
    typeof modelPreset !== "string"
    || modelPreset.length === 0
    || typeof nodeId !== "string"
    || nodeId.length === 0
    || registry === undefined
  ) {
    return;
  }
  const node = registry.getConnectedNodeAdvertised(nodeId);
  for (const candidate of node?.modelPresets ?? []) {
    const preset = asRecord(candidate);
    if (preset?.id === modelPreset) {
      if (typeof preset.label === "string" && preset.label.length > 0) {
        payload.modelLabel = preset.label;
      }
      if (typeof preset.backend === "string" && preset.backend.length > 0) {
        payload.backend = preset.backend;
      }
      return;
    }
  }
}

function normalizeReviewState(value: unknown): string {
  return value === "needs_review" || value === "acknowledged"
    ? value
    : "not_required";
}


export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "toISOString" in value) {
    const method = (value as { toISOString?: unknown }).toISOString;
    if (typeof method === "function") return method.call(value) as string;
  }
  return String(value);
}

function enrichAgent(
  payload: Record<string, unknown>,
  registry: InMemoryNodeRegistry | undefined,
  agentProfiles: readonly AgentProfileIdentityOverlay[],
  agentPortraitUrl: AgentPortraitUrlResolver | undefined,
): void {
  const agentId = payload.agentId;
  if (typeof agentId !== "string" || agentId.length === 0 || registry === undefined) {
    return;
  }
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
  const profile = findRegisteredAgentProfile(
    registry,
    agentId,
    nodeId,
    agentProfiles,
  );
  if (profile === undefined) return;
  payload.agentId = profile.id;
  if (typeof profile.agent.name === "string" && profile.agent.name.length > 0) {
    payload.agentName = profile.agent.name;
  }
  payload.backend = profile.backend;
  const portraitUrl = agentPortraitUrl?.(profile.id) ?? "";
  if (portraitUrl !== "") payload.agentPortraitUrl = portraitUrl;
}

function applyUserProfileFallback(
  payload: Record<string, unknown>,
  callerInfo: CallerInfo | undefined,
  registry: InMemoryNodeRegistry | undefined,
): void {
  if (callerInfo !== undefined && hasCallerIdentity(callerInfo)) return;
  if (payload.userName || payload.userPortraitUrl) return;
  const nodeId = payload.nodeId;
  if (typeof nodeId !== "string" || nodeId.length === 0 || registry === undefined) {
    return;
  }
  const userInfo = registry.getUserInfo(nodeId);
  if (typeof userInfo.name === "string" && userInfo.name.length > 0) {
    payload.userName = userInfo.name;
  }
  if (userInfo.hasPortrait === true) {
    payload.userPortraitUrl = `/api/nodes/${nodeId}/user/portrait`;
  }
}

function firstNonNullish(
  row: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let explicitNull: unknown = undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
    if (value === null) explicitNull = null;
  }
  return explicitNull;
}

function firstDefined(
  row: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

const REASONING_EFFORT_AUTO_MARKER = "auto";

export function publicReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value === REASONING_EFFORT_AUTO_MARKER ? null : value;
}
