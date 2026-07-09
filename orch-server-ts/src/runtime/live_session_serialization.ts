import type { InMemoryNodeRegistry } from "../node/registry.js";

export type SessionSerializationOptions = {
  readonly registry?: InMemoryNodeRegistry;
};

const IDENTITY_BEARING_SOURCES = new Set([
  "agent",
  "system",
  "slack",
  "soul-app",
  "channel_observer",
  "trello_watcher",
  "llm",
]);

export function serializeSessionRow(
  row: Record<string, unknown>,
  options: SessionSerializationOptions = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    agentSessionId: row.session_id,
    status: row.status,
    prompt: row.prompt,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    sessionType: row.session_type ?? "claude",
    lastMessage: row.last_message,
    clientId: row.client_id,
    metadata: row.metadata,
    displayName: row.display_name,
    nodeId: row.node_id,
    folderId: row.folder_id,
    lastEventId: row.last_event_id ?? 0,
    lastReadEventId: row.last_read_event_id ?? 0,
    callerSessionId: row.caller_session_id,
    agentId: row.agent_id,
    agentName: null,
    agentPortraitUrl: null,
    backend: null,
    userName: null,
    userPortraitUrl: null,
  };

  enrichAgent(payload, options.registry);
  const callerInfo = extractCallerInfo(row.metadata);
  if (callerInfo !== null) {
    const displayName = callerInfo.display_name;
    const avatarUrl = callerInfo.avatar_url;
    if (typeof displayName === "string" && displayName.length > 0) {
      payload.userName = displayName;
    }
    if (typeof avatarUrl === "string" && avatarUrl.length > 0) {
      payload.userPortraitUrl = avatarUrl;
    }
  }
  applyUserProfileNoopPolicy(payload, callerInfo);
  return payload;
}

export function serializeTaskRow(
  row: Record<string, unknown>,
  linkedSession: Record<string, unknown> | undefined,
  options: SessionSerializationOptions = {},
): Record<string, unknown> {
  return {
    id: row.id,
    parentId: row.parent_id,
    positionKey: row.position_key,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    verificationOwner: row.verification_owner,
    status: row.status,
    linkedSessionId: row.linked_session_id,
    linkedNodeId: row.linked_node_id,
    activeForSessionId: row.active_for_session_id,
    createdFromSessionId: row.created_from_session_id,
    createdFromEventId: row.created_from_event_id,
    navigationSessionId: row.navigation_session_id,
    navigationNodeId: row.navigation_node_id,
    navigationEventId: row.navigation_event_id,
    archived: row.archived,
    pinned: row.pinned,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    linkedSession:
      linkedSession === undefined ? null : serializeSessionRow(linkedSession, options),
  };
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
): void {
  const agentId = payload.agentId;
  if (typeof agentId !== "string" || agentId.length === 0 || registry === undefined) {
    return;
  }
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
  const profile = findAgentProfile(registry, agentId, nodeId);
  if (profile === undefined) return;
  if (typeof profile.agent.name === "string" && profile.agent.name.length > 0) {
    payload.agentName = profile.agent.name;
  }
  payload.backend =
    typeof profile.agent.backend === "string" && profile.agent.backend.length > 0
      ? profile.agent.backend
      : "claude";
  if (typeof profile.agent.portrait_url === "string" && profile.agent.portrait_url) {
    payload.agentPortraitUrl =
      `/api/nodes/${profile.nodeId}/agents/${agentId}/portrait`;
  }
}

function findAgentProfile(
  registry: InMemoryNodeRegistry,
  agentId: string,
  preferredNodeId: string | undefined,
): { nodeId: string; agent: Record<string, unknown> } | undefined {
  const matches = registry.listConnectedNodes().flatMap((node) =>
    node.agents.flatMap((agent) => {
      const record = asRecord(agent);
      return record?.id === agentId ? [{ nodeId: node.nodeId, agent: record }] : [];
    }),
  );
  return (
    matches.find((match) => match.nodeId === preferredNodeId) ?? matches[0]
  );
}

function extractCallerInfo(metadata: unknown): Record<string, unknown> | null {
  if (Array.isArray(metadata)) {
    let lastAny: Record<string, unknown> | null = null;
    let lastWithIdentity: Record<string, unknown> | null = null;
    for (const entry of metadata) {
      const record = asRecord(entry);
      if (record?.type !== "caller_info") continue;
      const value = asRecord(record.value);
      if (value === null) continue;
      lastAny = value;
      if (hasCallerIdentity(value)) lastWithIdentity = value;
    }
    return lastWithIdentity ?? lastAny;
  }
  const record = asRecord(metadata);
  if (record === null) return null;
  return asRecord(record.caller_info) ?? asRecord(record.callerInfo);
}

function hasCallerIdentity(callerInfo: Record<string, unknown>): boolean {
  const source = callerInfo.source;
  const displayName = callerInfo.display_name;
  const avatarUrl = callerInfo.avatar_url;
  return (
    (typeof source === "string" && IDENTITY_BEARING_SOURCES.has(source)) ||
    (typeof displayName === "string" && displayName.length > 0) ||
    (typeof avatarUrl === "string" && avatarUrl.length > 0)
  );
}

function applyUserProfileNoopPolicy(
  payload: Record<string, unknown>,
  callerInfo: Record<string, unknown> | null,
): void {
  const source = callerInfo?.source;
  if (typeof source === "string" && IDENTITY_BEARING_SOURCES.has(source)) return;
  if (payload.userName || payload.userPortraitUrl) return;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
