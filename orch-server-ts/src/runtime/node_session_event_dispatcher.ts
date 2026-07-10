import type {
  InMemoryNodeRegistry,
  NodeRegistryEvent,
} from "../node/registry.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { serializeSessionRow } from "./live_session_serialization.js";

export type NodeSessionEventDispatchResult = {
  appended: number;
  skipped: number;
  failed: number;
};

export type NodeRegistryEventSink = (events: NodeRegistryEvent[]) => void;

export function createNodeSessionEventBroadcasterSink(
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  registry?: InMemoryNodeRegistry,
): NodeRegistryEventSink {
  return (events) => {
    dispatchNodeRegistryEventsToSessionBroadcaster(events, broadcaster, registry);
  };
}

export function dispatchNodeRegistryEventsToSessionBroadcaster(
  events: NodeRegistryEvent[],
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  registry?: InMemoryNodeRegistry,
): NodeSessionEventDispatchResult {
  const result: NodeSessionEventDispatchResult = {
    appended: 0,
    skipped: 0,
    failed: 0,
  };

  for (const event of events) {
    const streamEvent = sessionStreamEventFromNodeRegistryEvent(event, registry);
    if (streamEvent === undefined) {
      result.skipped += 1;
      continue;
    }
    try {
      broadcaster.append(streamEvent);
      result.appended += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

function sessionStreamEventFromNodeRegistryEvent(
  event: NodeRegistryEvent,
  registry: InMemoryNodeRegistry | undefined,
): SessionStreamEvent | undefined {
  if (event.type === "node_session_session_created") {
    return sessionCreatedStreamEvent(event.nodeId, event.data, registry);
  }
  if (event.type === "node_session_session_updated") {
    const agentSessionId = sessionIdFromPayload(event.data);
    const session = serializeCachedSession(
      event.nodeId,
      agentSessionId,
      event.data,
      registry,
    );
    return {
      type: "session_updated",
      ...event.data,
      ...session,
      agent_session_id: agentSessionId,
      nodeId: event.nodeId,
    };
  }
  if (event.type === "node_session_session_deleted") {
    const agentSessionId = sessionIdFromPayload(event.data);
    if (agentSessionId === undefined) return undefined;
    return {
      type: "session_deleted",
      agent_session_id: agentSessionId,
    };
  }
  if (event.type === "node_session_event") {
    return customStreamEventFromEnvelope(event.nodeId, event.data);
  }
  return undefined;
}

function sessionCreatedStreamEvent(
  nodeId: string,
  data: Record<string, unknown>,
  registry: InMemoryNodeRegistry | undefined,
): SessionStreamEvent {
  const folderKeyPresent = "folder_id" in data || "folderId" in data;
  const folderId = "folder_id" in data ? data.folder_id : data.folderId;
  const rawSession = isRecord(data.session) ? data.session : data;
  const agentSessionId = sessionIdFromPayload(data);
  const session = {
    ...rawSession,
    ...serializeCachedSession(nodeId, agentSessionId, rawSession, registry),
  };
  if (folderKeyPresent) {
    session.folder_id = folderId;
    session.folderId = folderId;
  }

  const payload: SessionStreamEvent = {
    type: "session_created",
    session,
    nodeId,
  };
  if (folderKeyPresent) {
    payload.folder_id = folderId;
    payload.folderId = folderId;
  }
  return payload;
}

function serializeCachedSession(
  nodeId: string,
  agentSessionId: string | undefined,
  fallback: Record<string, unknown>,
  registry: InMemoryNodeRegistry | undefined,
): Record<string, unknown> {
  const cached = agentSessionId === undefined
    ? undefined
    : registry?.sessionCache.findSession(agentSessionId);
  return serializeSessionRow(
    {
      ...(cached?.payload ?? fallback),
      session_id: agentSessionId,
      node_id: nodeId,
      status: cached?.status ?? fallback.status,
      last_event_id: cached?.lastEventId ?? fallback.last_event_id,
    },
    { registry },
  );
}

function customStreamEventFromEnvelope(
  nodeId: string,
  data: Record<string, unknown>,
): SessionStreamEvent | undefined {
  const payload = isRecord(data.event)
    ? data.event
    : isRecord(data.payload)
      ? data.payload
      : data.type === "catalog_updated"
        ? data
        : undefined;
  if (payload === undefined) return undefined;
  if (
    payload.type !== "catalog_updated" &&
    payload.type !== "runbook_updated" &&
    payload.type !== "custom_view_updated"
  ) {
    return undefined;
  }
  return {
    ...payload,
    type: payload.type,
    nodeId,
  };
}

function sessionIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const session = isRecord(payload.session) ? payload.session : {};
  for (const key of [
    "agentSessionId",
    "agent_session_id",
    "sessionId",
    "session_id",
    "id",
  ]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const key of [
    "agentSessionId",
    "agent_session_id",
    "sessionId",
    "session_id",
    "id",
  ]) {
    const value = session[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
