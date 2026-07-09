import type { NodeRegistryEvent } from "../node/registry.js";

export type RuntimeSessionEvent = {
  readonly nodeId: string;
  readonly data: Record<string, unknown>;
};

export type RuntimeSessionEventListener = (event: RuntimeSessionEvent) => void;

export class RuntimeSessionEventHub {
  private readonly listenersBySession = new Map<
    string,
    Set<RuntimeSessionEventListener>
  >();

  subscribe(
    agentSessionId: string,
    listener: RuntimeSessionEventListener,
  ): () => void {
    let listeners = this.listenersBySession.get(agentSessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listenersBySession.set(agentSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.listenersBySession.delete(agentSessionId);
      }
    };
  }

  dispatchNodeRegistryEvents(events: readonly NodeRegistryEvent[]): void {
    for (const event of events) {
      if (event.type !== "node_session_event") continue;
      const agentSessionId = sessionIdFromEnvelope(event.data);
      if (agentSessionId === undefined) continue;
      const listeners = this.listenersBySession.get(agentSessionId);
      if (listeners === undefined) continue;
      const runtimeEvent = {
        nodeId: event.nodeId,
        data: event.data,
      };
      for (const listener of listeners) {
        listener(runtimeEvent);
      }
    }
  }
}

export function createRuntimeSessionEventHubSink(
  hub: RuntimeSessionEventHub,
): (events: NodeRegistryEvent[]) => void {
  return (events) => {
    hub.dispatchNodeRegistryEvents(events);
  };
}

function sessionIdFromEnvelope(
  envelope: Record<string, unknown>,
): string | undefined {
  for (const key of ["agentSessionId", "agent_session_id", "sessionId", "session_id"]) {
    const value = envelope[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  const event = envelope.event;
  if (isRecord(event)) {
    for (const key of [
      "agentSessionId",
      "agent_session_id",
      "sessionId",
      "session_id",
    ]) {
      const value = event[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
