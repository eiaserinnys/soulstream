import type { SessionSnapshotListResponse } from "../session/session_snapshot_service.js";
import type { NodeRegistryEventSink } from "../runtime/node_session_event_dispatcher.js";
import type { InMemoryNodeRegistry } from "./registry.js";

const DEFAULT_SEED_PAGE_SIZE = 200;

type SessionCacheSeedRepository = {
  listSessionSnapshots(input: {
    nodeId: string;
    offset: number;
    limit: number;
  }): Promise<SessionSnapshotListResponse>;
};

export function createSessionCacheSeedSink(input: {
  registry: InMemoryNodeRegistry;
  repository: SessionCacheSeedRepository;
  logError(error: unknown, message: string): void;
  nowMs?: () => number;
  pageSize?: number;
}): NodeRegistryEventSink {
  const nowMs = input.nowMs ?? Date.now;
  const pageSize = input.pageSize ?? DEFAULT_SEED_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`session cache seed pageSize must be a positive integer: ${pageSize}`);
  }

  return (events) => {
    for (const event of events) {
      if (event.type !== "node_registered") continue;
      void seedConnection(event.nodeId, event.connectionId).catch((error) => {
        input.logError(error, `session cache DB seed failed for ${event.nodeId}`);
      });
    }
  };

  async function seedConnection(nodeId: string, connectionId: string): Promise<void> {
    const snapshotStartedAtMs = nowMs();
    const sessions: Record<string, unknown>[] = [];
    let offset = 0;
    let total = 0;

    do {
      const page = await input.repository.listSessionSnapshots({
        nodeId,
        offset,
        limit: pageSize,
      });
      sessions.push(...page.sessions);
      total = page.total;
      if (page.sessions.length === 0) break;
      offset += page.sessions.length;
    } while (offset < total);

    const connected = input.registry.getConnectedNode(nodeId);
    if (connected?.connectionId !== connectionId) return;
    input.registry.sessionCache.seedNodeSessions({
      nodeId,
      connectionId,
      sessions,
      snapshotStartedAtMs,
      nowMs: nowMs(),
    });
  }
}
