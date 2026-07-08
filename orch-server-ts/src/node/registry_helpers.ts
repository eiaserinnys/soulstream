import type {
  IgnoredStaleMessageEvent,
  MutableNodeConnection,
  NodeConnectionSnapshot,
  NodeMessageSource,
} from "./registry_types.js";

export function supportsAppHeartbeat(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.app_heartbeat_v1 === true;
}

export function snapshotNode(
  node: MutableNodeConnection,
): NodeConnectionSnapshot {
  return {
    nodeId: node.nodeId,
    connectionId: node.connectionId,
    host: node.host,
    port: node.port,
    agents: [...node.agents],
    capabilities: { ...node.capabilities },
    supportedBackends: [...node.supportedBackends],
    connected: node.connected,
    status: node.connected ? "connected" : "disconnected",
    connectedAtMs: node.connectedAtMs,
    disconnectedAtMs: node.disconnectedAtMs,
    lastSeenAtMs: node.lastSeenAtMs,
    heartbeat: { ...node.heartbeat },
    pendingCommandCount: node.pendingCommands.pendingCount,
  };
}

export function normalizeMessageSource(source: NodeMessageSource): {
  nodeId: string;
  connectionId: string | undefined;
} {
  return typeof source === "string"
    ? { nodeId: source, connectionId: undefined }
    : { nodeId: source.nodeId, connectionId: source.connectionId };
}

export function ignoredStaleMessageEvent(params: {
  nodeId: string;
  connectionId: string;
  currentConnectionId: string | undefined;
  message: Record<string, unknown>;
}): IgnoredStaleMessageEvent {
  return {
    type: "ignored_stale_message",
    nodeId: params.nodeId,
    connectionId: params.connectionId,
    currentConnectionId: params.currentConnectionId,
    messageType: messageType(params.message),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageType(message: Record<string, unknown>): string {
  return typeof message.type === "string" ? message.type : "<unknown>";
}
