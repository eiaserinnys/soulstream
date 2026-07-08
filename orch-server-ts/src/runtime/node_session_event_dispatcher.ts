import type { NodeRegistryEvent } from "../node/registry.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export type NodeSessionEventDispatchResult = {
  appended: number;
  skipped: number;
  failed: number;
};

export type NodeRegistryEventSink = (events: NodeRegistryEvent[]) => void;

export function createNodeSessionEventBroadcasterSink(
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): NodeRegistryEventSink {
  return (events) => {
    dispatchNodeRegistryEventsToSessionBroadcaster(events, broadcaster);
  };
}

export function dispatchNodeRegistryEventsToSessionBroadcaster(
  events: NodeRegistryEvent[],
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): NodeSessionEventDispatchResult {
  const result: NodeSessionEventDispatchResult = {
    appended: 0,
    skipped: 0,
    failed: 0,
  };

  for (const event of events) {
    const streamEvent = sessionStreamEventFromNodeRegistryEvent(event);
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
): SessionStreamEvent | undefined {
  if (event.type === "node_session_session_created") {
    return sessionCreatedStreamEvent(event.nodeId, event.data);
  }
  if (event.type === "node_session_session_updated") {
    const agentSessionId = sessionIdFromPayload(event.data);
    return {
      type: "session_updated",
      ...event.data,
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
): SessionStreamEvent {
  const folderKeyPresent = "folder_id" in data || "folderId" in data;
  const folderId = "folder_id" in data ? data.folder_id : data.folderId;
  const session = {
    ...(isRecord(data.session) ? data.session : data),
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

function customStreamEventFromEnvelope(
  nodeId: string,
  data: Record<string, unknown>,
): SessionStreamEvent | undefined {
  const payload = isRecord(data.event)
    ? data.event
    : isRecord(data.payload)
      ? data.payload
      : undefined;
  if (payload === undefined) return undefined;
  if (payload.type !== "runbook_updated" && payload.type !== "custom_view_updated") {
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
