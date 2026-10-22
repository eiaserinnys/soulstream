import type { InMemoryNodeRegistry, NodeConnectionSnapshot } from "./registry.js";
import type { NodeResourceSnapshot } from "@soulstream/wire-schema/node-resources";

export type NodeSnapshotRecord = {
  nodeId: string;
  host: string;
  port: number;
  capabilities: Record<string, unknown>;
  supportedBackends: string[];
  connectedAt: string;
  sessionCount: number;
  status: "connected" | "disconnected";
  connectionId: string;
  lastSeenAtMs: number;
  connectedAtMs: number;
  heartbeat: NodeConnectionSnapshot["heartbeat"];
  pendingCommandCount: number;
  connected: boolean;
  disconnectedAt?: string;
  disconnectedAtMs?: number;
  resources?: NodeResourceSnapshot;
};

export type NodeSnapshotListResponse = {
  nodes: NodeSnapshotRecord[];
};

export type NodeSnapshotServiceOptions = {
  registry: InMemoryNodeRegistry;
};

export class NodeSnapshotService {
  private readonly registry: InMemoryNodeRegistry;

  constructor(options: NodeSnapshotServiceOptions) {
    this.registry = options.registry;
  }

  listNodes(options: { includeDisconnected?: boolean } = {}): NodeSnapshotListResponse {
    return {
      nodes: this.registry
        [options.includeDisconnected === true ? "listAllNodes" : "listConnectedNodes"]()
        .map((node) => this.projectNode(node)),
    };
  }

  getNode(nodeId: string): NodeSnapshotRecord | undefined {
    const node = this.registry.getConnectedNode(nodeId);
    return node === undefined ? undefined : this.projectNode(node);
  }

  projectNode(node: NodeConnectionSnapshot): NodeSnapshotRecord {
    return {
      nodeId: node.nodeId,
      host: node.host,
      port: node.port,
      capabilities: node.capabilities,
      supportedBackends: node.supportedBackends,
      connectedAt: new Date(node.connectedAtMs).toISOString(),
      sessionCount: this.registry.sessionCache.getSessionsForNode(node.nodeId).length,
      status: node.status,
      connectionId: node.connectionId,
      lastSeenAtMs: node.lastSeenAtMs,
      connectedAtMs: node.connectedAtMs,
      heartbeat: node.heartbeat,
      pendingCommandCount: node.pendingCommandCount,
      connected: node.connected,
      ...(node.disconnectedAtMs !== undefined
        ? {
            disconnectedAt: new Date(node.disconnectedAtMs).toISOString(),
            disconnectedAtMs: node.disconnectedAtMs,
          }
        : {}),
      ...(node.resources ? { resources: node.resources } : {}),
    };
  }
}
