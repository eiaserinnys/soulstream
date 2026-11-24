import { isRecord } from "@soulstream/wire-schema/json-record";
import type { McpCentralSnapshot, McpCentralSync } from "@soulstream/wire-schema";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import { PendingNodeCommandRejectedError, type RequestResponseNodeCommandPayload } from "../node/pending_commands.js";
import { supportsCentralMcpConfig } from "../node/registry_helpers.js";
import type { NodeRegistryEvent } from "../node/registry_types.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import { MissingMcpSecretError } from "./node_snapshot.js";
import { checkMcpSendGate } from "./send_gate.js";
import { McpCentralError } from "./errors.js";
import type { McpManagedNodeAck } from "./types.js";

type Snapshot = { revision: number; runtime: McpCentralSnapshot; display: McpCentralSnapshot };
type Options = {
  registry: InMemoryNodeRegistry;
  bridge: Pick<SessionCommandTransportBridge, "sendPendingCommand">;
  readGate: (nodeId: string) => Promise<{ managed: { activated_at: string | null } | null; hasBindings: boolean }>;
  buildSnapshot: (nodeId: string) => Promise<Snapshot>;
  updateAck: (nodeId: string, ack: McpManagedNodeAck) => Promise<void>;
  listManagedNodes: () => Promise<string[]>;
  currentRevision: () => Promise<number>;
  onWarning?: (message: string) => void;
};
type Queue = { running: boolean; followUp: Promise<boolean> | null; resolve: ((result: boolean) => void) | null };
type Payload = RequestResponseNodeCommandPayload<McpCentralSync["type"]> & Pick<McpCentralSync, "revision" | "runtime" | "display">;

export class McpCentralSyncService {
  private readonly acks = new Map<string, { connectionId: string; revision: number }>();
  private readonly queues = new Map<string, Queue>();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: Options) {}

  nodeStatus(nodeId: string) {
    const node = this.options.registry.getConnectedNode(nodeId);
    const ack = this.acks.get(nodeId);
    return { connected: node !== undefined, central_sync_supported: node !== undefined && supportsCentralMcpConfig(node.capabilities),
      ack: node && ack?.connectionId === node.connectionId ? { revision: ack.revision } : null };
  }

  async sendAux(nodeId: string, build: () => Promise<RequestResponseNodeCommandPayload>, inScope?: () => Promise<boolean>) {
    const gate = await checkMcpSendGate({ nodeId, registry: this.options.registry, readGate: this.options.readGate, inScope });
    if (!gate.ok) throw new McpCentralError(gate.reason === "unmanaged" ? "MCP_NODE_NOT_MANAGED" : gate.reason === "out_of_scope" ? "MCP_SERVER_OUT_OF_SCOPE" : "MCP_NODE_UNAVAILABLE",
      gate.reason === "unmanaged" || gate.reason === "out_of_scope" ? 403 : 503,
      gate.reason === "unsupported" ? "이 노드는 중앙 MCP 설정을 받지 않습니다(무설치 실행기이거나 옛 판)." : "MCP node is unavailable for this request");
    try {
      const payload = await build();
      const command = this.options.registry.createCommand(nodeId, payload, { timeoutMs: 15_000 });
      const response = await this.options.bridge.sendPendingCommand({ node: gate.node, command });
      if (response.success !== true || !isRecord(response.data)) throw new McpCentralError("MCP_NODE_UNAVAILABLE", 503, "MCP command failed");
      return response.data;
    } catch (error) {
      if (error instanceof McpCentralError) throw error;
      if (error instanceof PendingNodeCommandRejectedError) {
        const code = codeOf(error.response);
        if (code === "MCP_PORTABLE_NODE") throw new McpCentralError(code, 403, "Portable node cannot receive this command");
        if (code === "MCP_AGENT_NOT_FOUND") throw new McpCentralError(code, 404, "Agent not found");
      }
      throw new McpCentralError("MCP_NODE_UNAVAILABLE", 503, "MCP node command failed");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.reconcile(); }, 30_000);
    void this.reconcile();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  notifyConfigChanged(): void { void this.sendAll(); }
  acceptNodeEvents(events: readonly NodeRegistryEvent[]): void {
    for (const event of events) {
      if (event.type !== "node_registered" && event.type !== "node_unregistered") continue;
      this.acks.delete(event.nodeId);
      if (event.type === "node_registered") queueMicrotask(() => { void this.sendManagedNodeMcpCommand(event.nodeId); });
    }
  }
  async reconcile(): Promise<void> {
    try {
      const [ids, revision] = await Promise.all([this.options.listManagedNodes(), this.options.currentRevision()]);
      await Promise.all(ids.filter(id => {
        const node = this.options.registry.getConnectedNode(id);
        const ack = this.acks.get(id);
        return node && (!ack || ack.connectionId !== node.connectionId || ack.revision !== revision);
      }).map(id => this.sendManagedNodeMcpCommand(id)));
    } catch { this.warn("MCP central reconciliation failed"); }
  }
  private async sendAll(): Promise<void> {
    try { await Promise.all((await this.options.listManagedNodes()).map(id => this.sendManagedNodeMcpCommand(id))); }
    catch { this.warn("MCP central notification failed"); }
  }
  async sendManagedNodeMcpCommand(nodeId: string): Promise<boolean> {
    let queue = this.queues.get(nodeId);
    if (!queue) { queue = { running: false, followUp: null, resolve: null }; this.queues.set(nodeId, queue); }
    if (queue.running) {
      if (!queue.followUp) queue.followUp = new Promise(resolve => { queue!.resolve = resolve; });
      return queue.followUp;
    }
    queue.running = true;
    try {
      let result = await this.sendOnce(nodeId);
      while (queue.followUp) {
        const resolve = queue.resolve!;
        queue.followUp = null; queue.resolve = null;
        result = await this.sendOnce(nodeId);
        resolve(result);
      }
      return result;
    } finally { queue.running = false; this.queues.delete(nodeId); }
  }
  private async sendOnce(nodeId: string): Promise<boolean> {
    try {
      const gate = await checkMcpSendGate({ nodeId, registry: this.options.registry, readGate: this.options.readGate });
      if (!gate.ok) return false;
      const { node } = gate;
      if (gate.managed.activated_at === null && !gate.hasBindings) return false;
      const { revision, runtime, display } = await this.options.buildSnapshot(nodeId);
      const payload: Payload = { type: "mcp_central_sync", revision, runtime, display };
      const command = this.options.registry.createCommand(nodeId, payload, { timeoutMs: 10_000 });
      const response = await this.options.bridge.sendPendingCommand({ node, command });
      if (response.success !== true || !isRecord(response.data) || !Number.isSafeInteger(response.data.applied_revision) || (response.data.applied_revision as number) < 0) {
        throw new SyncFailure(codeOf(response));
      }
      const applied = response.data.applied_revision as number;
      await this.options.updateAck(nodeId, { applied_mode: "central", applied_revision: applied,
        last_sync_at: new Date().toISOString(), last_sync_error: null, activate: true });
      if (this.options.registry.getConnectedNode(nodeId)?.connectionId === node.connectionId) {
        this.acks.set(nodeId, { connectionId: node.connectionId, revision: applied });
      }
      return true;
    } catch (error) {
      const detail = failureDetail(error);
      this.warn(`MCP central sync failed for ${nodeId}: ${detail}`);
      try { await this.options.updateAck(nodeId, { last_sync_error: detail }); }
      catch { this.warn(`MCP central sync status update failed for ${nodeId}`); }
      return false;
    }
  }
  private warn(message: string): void { try { this.options.onWarning?.(message); } catch { /* notification is optional */ } }
}

class SyncFailure extends Error { constructor(readonly code: string) { super(code); } }
function codeOf(value: unknown): string {
  if (!isRecord(value)) return "MCP_SYNC_FAILED";
  const code = value.code ?? (isRecord(value.error) ? value.error.code : undefined);
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "MCP_SYNC_FAILED";
}
function failureDetail(error: unknown): string {
  if (error instanceof MissingMcpSecretError) return `${error.code}: ${error.message}`;
  if (error instanceof SyncFailure) return error.code;
  if (error instanceof PendingNodeCommandRejectedError) return codeOf(error.response);
  return "MCP_SYNC_FAILED";
}
