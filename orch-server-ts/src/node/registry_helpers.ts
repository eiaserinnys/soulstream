import { isRecord } from "@soulstream/wire-schema/json-record";
import type {
  IgnoredStaleMessageEvent,
  MutableNodeConnection,
  NodeConnectionSnapshot,
  NodeMessageSource,
} from "./registry_types.js";

export function supportsAppHeartbeat(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.app_heartbeat_v1 === true;
}

export function supportsRunnerInventory(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.runner_inventory_v1 === true;
}

export function supportsCentralMcpConfig(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.central_mcp_config_v1 === true;
}

export function supportsClaudeAccountPool(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.claude_account_pool_v1 === true;
}

export function supportsAgentLogin(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.agent_login_v1 === true;
}

export function supportsNodeGitSetup(capabilities: unknown): boolean {
  return isRecord(capabilities) && capabilities.node_git_setup_v1 === true;
}

export function runnerInventoryCommandType(
  capabilities: unknown,
): "list_runner_inventory" | "list_sessions" {
  return supportsRunnerInventory(capabilities)
    ? "list_runner_inventory"
    : "list_sessions";
}

const ANTIGRAVITY_BACKEND = "antigravity";

/** `advertiseAntigravity: false` hides the Antigravity presets, backend and agents; the stored advertisement is untouched. */
export function snapshotNode(
  node: MutableNodeConnection,
  advertiseAntigravity = true,
): NodeConnectionSnapshot {
  const modelPresets = advertiseAntigravity
    ? node.modelPresets
    : node.modelPresets?.filter((preset) => !(isRecord(preset) && preset.backend === ANTIGRAVITY_BACKEND));
  const agents = advertiseAntigravity
    ? node.agents
    : node.agents.filter((agent) => !(isRecord(agent) && agent.backend === ANTIGRAVITY_BACKEND));
  const supportedBackends = advertiseAntigravity
    ? node.supportedBackends
    : node.supportedBackends.filter((backend) => backend !== ANTIGRAVITY_BACKEND);
  return {
    nodeId: node.nodeId,
    connectionId: node.connectionId,
    host: node.host,
    port: node.port,
    agents: [...agents],
    ...(modelPresets ? { modelPresets: [...modelPresets] } : {}),
    capabilities: { ...node.capabilities },
    supportedBackends: [...supportedBackends],
    connected: node.connected,
    status: node.connected ? "connected" : "disconnected",
    connectedAtMs: node.connectedAtMs,
    disconnectedAtMs: node.disconnectedAtMs,
    lastSeenAtMs: node.lastSeenAtMs,
    heartbeat: { ...node.heartbeat },
    controlAckMetrics: Object.fromEntries(
      Object.entries(node.controlAckMetrics).map(([family, metric]) => [
        family,
        { ...metric },
      ]),
    ),
    pendingCommandCount: node.pendingCommands.pendingCount,
    ...(node.resources ? { resources: {
      collectedAt: node.resources.collectedAt,
      cpu: { ...node.resources.cpu },
      memory: { ...node.resources.memory },
      disk: node.resources.disk ? { ...node.resources.disk } : null,
      diskQueue: node.resources.diskQueue ? { ...node.resources.diskQueue } : null,
    } } : {}),
  };
}

export function registryStats(
  nodes: Iterable<MutableNodeConnection>,
): { nodes: number; connectedNodes: number; pendingCommands: number } {
  let nodeCount = 0;
  let connectedNodes = 0;
  let pendingCommands = 0;
  for (const node of nodes) {
    nodeCount += 1;
    if (node.connected) connectedNodes += 1;
    pendingCommands += node.pendingCommands.pendingCount;
  }
  return { nodes: nodeCount, connectedNodes, pendingCommands };
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

function messageType(message: Record<string, unknown>): string {
  return typeof message.type === "string" ? message.type : "<unknown>";
}
