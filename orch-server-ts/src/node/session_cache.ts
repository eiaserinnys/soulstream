import type { NodeCommandResponse } from "./pending_commands.js";

export type CachedNodeSession = {
  nodeId: string;
  connectionId: string;
  agentSessionId: string;
  status: string | undefined;
  lastEventId: number | undefined;
  fresh: boolean;
  payload: Record<string, unknown>;
  updatedAtMs: number;
};

export class PerNodeSessionCache {
  private readonly sessionsByNode = new Map<string, Map<string, CachedNodeSession>>();
  private readonly nodeBySession = new Map<string, string>();

  getSessionsForNode(nodeId: string): CachedNodeSession[] {
    return [...(this.sessionsByNode.get(nodeId)?.values() ?? [])].map(copySession);
  }

  findSession(agentSessionId: string): CachedNodeSession | undefined {
    const nodeId = this.nodeBySession.get(agentSessionId);
    if (nodeId === undefined) return undefined;
    return this.getSessionForNode(nodeId, agentSessionId);
  }

  getSessionForNode(
    nodeId: string,
    agentSessionId: string,
  ): CachedNodeSession | undefined {
    const session = this.sessionsByNode.get(nodeId)?.get(agentSessionId);
    return session === undefined ? undefined : copySession(session);
  }

  upsertFromCommandAck(params: {
    nodeId: string;
    connectionId: string;
    response: NodeCommandResponse;
    nowMs: number;
  }): CachedNodeSession | undefined {
    const agentSessionId = sessionIdFromPayload(params.response);
    if (agentSessionId === undefined) return undefined;

    return this.storeSession({
      nodeId: params.nodeId,
      connectionId: params.connectionId,
      agentSessionId,
      status: sessionStatusFromPayload(params.response) ?? "created",
      lastEventId: lastEventIdFromPayload(params.response),
      fresh: true,
      payload: { ...params.response },
      updatedAtMs: params.nowMs,
    });
  }

  upsertFromEventRelay(params: {
    nodeId: string;
    connectionId: string;
    message: Record<string, unknown>;
    nowMs: number;
  }): CachedNodeSession | undefined {
    const agentSessionId = sessionIdFromPayload(params.message);
    if (agentSessionId === undefined) return undefined;

    const previous = this.findSession(agentSessionId);
    return this.storeSession({
      nodeId: params.nodeId,
      connectionId: params.connectionId,
      agentSessionId,
      status: previous?.status,
      lastEventId:
        lastEventIdFromEventRelay(params.message) ?? previous?.lastEventId,
      fresh: true,
      payload: {
        ...(previous?.payload ?? {}),
        last_event_id:
          lastEventIdFromEventRelay(params.message) ?? previous?.lastEventId,
      },
      updatedAtMs: params.nowMs,
    });
  }

  upsertFromSessionCreated(params: {
    nodeId: string;
    connectionId: string;
    message: Record<string, unknown>;
    nowMs: number;
  }): CachedNodeSession | undefined {
    const agentSessionId = sessionIdFromPayload(params.message);
    if (agentSessionId === undefined) return undefined;

    const session = nestedSession(params.message);
    const status = sessionStatusFromPayload(params.message) ?? "running";
    return this.storeSession({
      nodeId: params.nodeId,
      connectionId: params.connectionId,
      agentSessionId,
      status,
      lastEventId: lastEventIdFromPayload(params.message),
      fresh: true,
      payload: {
        ...session,
        ...selectedSessionCreateFields(params.message),
        agentSessionId,
        status,
        nodeId: params.nodeId,
      },
      updatedAtMs: params.nowMs,
    });
  }

  upsertFromSessionUpdated(params: {
    nodeId: string;
    connectionId: string;
    message: Record<string, unknown>;
    nowMs: number;
  }): CachedNodeSession | undefined {
    const agentSessionId = sessionIdFromPayload(params.message);
    if (agentSessionId === undefined) return undefined;

    const previous = this.findSession(agentSessionId);
    return this.storeSession({
      nodeId: params.nodeId,
      connectionId: params.connectionId,
      agentSessionId,
      status: sessionStatusFromPayload(params.message) ?? previous?.status,
      lastEventId: lastEventIdFromPayload(params.message) ?? previous?.lastEventId,
      fresh: true,
      payload: {
        ...(previous?.payload ?? {}),
        ...params.message,
      },
      updatedAtMs: params.nowMs,
    });
  }

  deleteFromSessionDeleted(params: {
    message: Record<string, unknown>;
  }): CachedNodeSession | undefined {
    const agentSessionId = sessionIdFromPayload(params.message);
    if (agentSessionId === undefined) return undefined;
    return this.deleteSession(agentSessionId);
  }

  replaceNodeSessions(params: {
    nodeId: string;
    connectionId: string;
    sessions: unknown[];
    nowMs: number;
  }): CachedNodeSession[] {
    const previous = this.sessionsByNode.get(params.nodeId);
    if (previous !== undefined) {
      for (const agentSessionId of previous.keys()) {
        this.nodeBySession.delete(agentSessionId);
      }
    }

    this.sessionsByNode.set(params.nodeId, new Map());
    const stored: CachedNodeSession[] = [];

    for (const rawSession of params.sessions) {
      if (!isRecord(rawSession)) continue;
      const agentSessionId = sessionIdFromPayload(rawSession);
      if (agentSessionId === undefined) continue;
      stored.push(
        this.storeSession({
          nodeId: params.nodeId,
          connectionId: params.connectionId,
          agentSessionId,
          status: sessionStatusFromPayload(rawSession),
          lastEventId: lastEventIdFromPayload(rawSession),
          fresh: true,
          payload: { ...rawSession },
          updatedAtMs: params.nowMs,
        }),
      );
    }

    return stored.map(copySession);
  }

  markNodeDisconnected(nodeId: string, nowMs: number): void {
    const sessions = this.sessionsByNode.get(nodeId);
    if (sessions === undefined) return;

    for (const session of sessions.values()) {
      sessions.set(session.agentSessionId, {
        ...session,
        fresh: false,
        updatedAtMs: nowMs,
      });
    }
  }

  private storeSession(session: CachedNodeSession): CachedNodeSession {
    const previousNodeId = this.nodeBySession.get(session.agentSessionId);
    if (previousNodeId !== undefined && previousNodeId !== session.nodeId) {
      this.sessionsByNode
        .get(previousNodeId)
        ?.delete(session.agentSessionId);
    }

    let sessions = this.sessionsByNode.get(session.nodeId);
    if (sessions === undefined) {
      sessions = new Map();
      this.sessionsByNode.set(session.nodeId, sessions);
    }

    const stored = copySession(session);
    sessions.set(session.agentSessionId, stored);
    this.nodeBySession.set(session.agentSessionId, session.nodeId);
    return copySession(stored);
  }

  private deleteSession(agentSessionId: string): CachedNodeSession | undefined {
    const nodeId = this.nodeBySession.get(agentSessionId);
    if (nodeId === undefined) return undefined;

    const sessions = this.sessionsByNode.get(nodeId);
    const stored = sessions?.get(agentSessionId);
    if (stored === undefined) return undefined;

    sessions?.delete(agentSessionId);
    if (sessions?.size === 0) {
      this.sessionsByNode.delete(nodeId);
    }
    this.nodeBySession.delete(agentSessionId);
    return copySession(stored);
  }
}

function copySession(session: CachedNodeSession): CachedNodeSession {
  return {
    ...session,
    payload: { ...session.payload },
  };
}

function sessionIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const session = nestedSession(payload);
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

function sessionStatusFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  if (typeof payload.status === "string") return payload.status;
  const session = nestedSession(payload);
  return typeof session.status === "string" ? session.status : undefined;
}

function lastEventIdFromPayload(
  payload: Record<string, unknown>,
): number | undefined {
  if (typeof payload.last_event_id === "number") return payload.last_event_id;
  if (typeof payload.lastEventId === "number") return payload.lastEventId;
  const session = nestedSession(payload);
  if (typeof session.last_event_id === "number") return session.last_event_id;
  if (typeof session.lastEventId === "number") return session.lastEventId;
  return undefined;
}

function lastEventIdFromEventRelay(
  payload: Record<string, unknown>,
): number | undefined {
  const event = payload.event;
  if (isRecord(event) && typeof event.id === "number") return event.id;
  return lastEventIdFromPayload(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedSession(payload: Record<string, unknown>): Record<string, unknown> {
  const session = payload.session;
  return isRecord(session) ? session : {};
}

function selectedSessionCreateFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of ["caller_source", "callerSource", "folder_id", "folderId"]) {
    if (key in payload) selected[key] = payload[key];
  }
  return selected;
}
