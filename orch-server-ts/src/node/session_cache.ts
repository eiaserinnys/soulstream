import type { NodeCommandResponse } from "./pending_commands.js";
import {
  isRecord,
  lastEventIdFromEventRelay,
  lastEventIdFromPayload,
  nestedSession,
  projectSessionPayload,
  selectedSessionCreateFields,
  sessionIdFromPayload,
  sessionStatusFromPayload,
} from "./session_cache_payload.js";

export const TERMINAL_SESSION_CACHE_TTL_MS = 10 * 60_000;
export const DISCONNECTED_SESSION_CACHE_TTL_MS = 24 * 60 * 60_000;

const TERMINAL_SESSION_STATUSES = new Set(["completed", "error"]);
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

type SessionWaiter = {
  nodeId: string;
  finish: (observed: boolean) => void;
};

export class PerNodeSessionCache {
  private readonly sessionsByNode = new Map<string, Map<string, CachedNodeSession>>();
  private readonly nodeBySession = new Map<string, string>();
  private readonly waitersBySession = new Map<string, Set<SessionWaiter>>();

  getSessionsForNode(nodeId: string): CachedNodeSession[] {
    return [...(this.sessionsByNode.get(nodeId)?.values() ?? [])].map(copySession);
  }

  getStats(): { nodes: number; sessions: number } {
    return {
      nodes: this.sessionsByNode.size,
      sessions: this.nodeBySession.size,
    };
  }

  listSessions(): CachedNodeSession[] {
    return [...this.sessionsByNode.values()].flatMap((sessions) =>
      [...sessions.values()].map(copySession),
    );
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

  waitForSession(params: {
    nodeId: string;
    agentSessionId: string;
    timeoutMs: number;
  }): Promise<boolean> {
    if (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 0) {
      throw new Error(
        `session cache wait timeoutMs must be a non-negative integer: ${params.timeoutMs}`,
      );
    }

    const existing = this.findSession(params.agentSessionId);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.nodeId === params.nodeId && existing.fresh,
      );
    }
    if (params.timeoutMs === 0) return Promise.resolve(false);

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: SessionWaiter = {
        nodeId: params.nodeId,
        finish: (observed) => {
          if (timer !== undefined) clearTimeout(timer);
          const waiters = this.waitersBySession.get(params.agentSessionId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) {
            this.waitersBySession.delete(params.agentSessionId);
          }
          resolve(observed);
        },
      };

      let waiters = this.waitersBySession.get(params.agentSessionId);
      if (waiters === undefined) {
        waiters = new Set();
        this.waitersBySession.set(params.agentSessionId, waiters);
      }
      waiters.add(waiter);
      timer = setTimeout(() => waiter.finish(false), params.timeoutMs);
    });
  }

  upsertFromCommandAck(params: {
    nodeId: string;
    connectionId: string;
    response: NodeCommandResponse;
    nowMs: number;
  }): CachedNodeSession | undefined {
    const agentSessionId = sessionIdFromPayload(params.response);
    if (agentSessionId === undefined) return undefined;
    // A command ACK owns correlation only. The direct session event or durable
    // session effect owns projection; a status-less ACK must never synthesize
    // `created` over an already-running session.
    return this.findSession(agentSessionId);
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
        ...projectSessionPayload(previous?.payload),
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
      payload: projectSessionPayload({
        ...session,
        ...selectedSessionCreateFields(params.message),
        agentSessionId,
        status,
        nodeId: params.nodeId,
      }),
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
      payload: projectSessionPayload(previous?.payload, params.message),
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
          payload: projectSessionPayload(rawSession),
          updatedAtMs: params.nowMs,
        }),
      );
    }

    return stored.map(copySession);
  }

  seedNodeSessions(params: {
    nodeId: string;
    connectionId: string;
    sessions: unknown[];
    snapshotStartedAtMs: number;
    nowMs: number;
  }): CachedNodeSession[] {
    const snapshotIds = new Set<string>();
    const stored: CachedNodeSession[] = [];

    for (const rawSession of params.sessions) {
      if (!isRecord(rawSession)) continue;
      const agentSessionId = sessionIdFromPayload(rawSession);
      if (agentSessionId === undefined) continue;
      snapshotIds.add(agentSessionId);
      const current = this.sessionsByNode.get(params.nodeId)?.get(agentSessionId);
      if (current !== undefined && current.updatedAtMs >= params.snapshotStartedAtMs) {
        stored.push(copySession(current));
        continue;
      }
      stored.push(this.storeSession({
        nodeId: params.nodeId,
        connectionId: params.connectionId,
        agentSessionId,
        status: sessionStatusFromPayload(rawSession),
        lastEventId: lastEventIdFromPayload(rawSession),
        fresh: true,
        payload: projectSessionPayload(rawSession),
        updatedAtMs: params.nowMs,
      }));
    }

    const currentSessions = this.sessionsByNode.get(params.nodeId);
    if (currentSessions !== undefined) {
      for (const [agentSessionId, current] of [...currentSessions]) {
        if (
          !snapshotIds.has(agentSessionId)
          && current.updatedAtMs < params.snapshotStartedAtMs
        ) {
          this.deleteSession(agentSessionId);
        }
      }
    }

    return stored;
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

  sweepExpired(nowMs = Date.now()): {
    terminalSessions: number;
    disconnectedSessions: number;
    total: number;
  } {
    let terminalSessions = 0;
    let disconnectedSessions = 0;
    for (const session of this.listSessions()) {
      const ageMs = nowMs - session.updatedAtMs;
      if (
        TERMINAL_SESSION_STATUSES.has(session.status ?? "") &&
        ageMs >= TERMINAL_SESSION_CACHE_TTL_MS
      ) {
        if (this.deleteSession(session.agentSessionId) !== undefined) {
          terminalSessions += 1;
        }
        continue;
      }
      if (!session.fresh && ageMs >= DISCONNECTED_SESSION_CACHE_TTL_MS) {
        if (this.deleteSession(session.agentSessionId) !== undefined) {
          disconnectedSessions += 1;
        }
      }
    }
    return {
      terminalSessions,
      disconnectedSessions,
      total: terminalSessions + disconnectedSessions,
    };
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
    this.notifySessionWaiters(stored);
    return copySession(stored);
  }

  private notifySessionWaiters(session: CachedNodeSession): void {
    const waiters = this.waitersBySession.get(session.agentSessionId);
    if (waiters === undefined) return;

    for (const waiter of [...waiters]) {
      waiter.finish(session.nodeId === waiter.nodeId && session.fresh);
    }
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
