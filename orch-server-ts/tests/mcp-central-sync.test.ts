import { describe, expect, it, vi } from "vitest";
import { InMemoryNodeRegistry, NodeCommandTransportHub, SessionCommandTransportBridge, loadContractFixtures, type NodeRegistrationPayload } from "../src/index.js";
import { McpCentralSyncService } from "../src/mcp_central/sync_service.js";

function harness() {
  const registry = new InMemoryNodeRegistry();
  const registration = loadContractFixtures().fakeNodeReconnect.registration as NodeRegistrationPayload;
  const registered = registry.registerNode({ ...registration, capabilities: { ...registration.capabilities, central_mcp_config_v1: true } });
  const { nodeId, connectionId } = registered.node;
  const transports = new NodeCommandTransportHub();
  const sent: Record<string, unknown>[] = [];
  let reject = false;
  transports.attach({ nodeId, connectionId, transport: { send(data) {
    const message = JSON.parse(data) as Record<string, unknown>;
    sent.push(message);
    registry.receiveNodeMessage({ nodeId, connectionId }, { requestId: message.requestId,
      ...(reject ? { type: "error", code: "MCP_PORTABLE_NODE", message: "fake-secret-node-error" }
        : { type: "mcp_central_sync", success: true, data: { applied_revision: message.revision } }) });
  } } });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  let managed = true, bound = true, active = false, revision = 1;
  const status = vi.fn(async (_id: string, ack: Record<string, unknown>) => { if (ack.applied_mode === "central") active = true; });
  const readGate = vi.fn(async () => ({ managed: managed ? { activated_at: active ? "now" : null } : null, hasBindings: bound }));
  const snapshot = vi.fn(async () => ({ revision, runtime: { registry: { servers: [] as object[] }, profiles: { profiles: [] }, agent_bindings: { a: "p" } }, display: { registry: { servers: [] }, profiles: { profiles: [] }, agent_bindings: { a: "p" } } }));
  const onWarning = vi.fn();
  const service = new McpCentralSyncService({ registry, bridge, readGate, buildSnapshot: snapshot, updateAck: status,
    listManagedNodes: async () => managed ? [nodeId] : [], currentRevision: async () => revision, onWarning });
  return { registry, registered, service, nodeId, connectionId, sent, snapshot, status, onWarning,
    setManaged: (value: boolean) => { managed = value; }, setBound: (value: boolean) => { bound = value; },
    setRevision: (value: number) => { revision = value; }, setReject: (value: boolean) => { reject = value; } };
}

describe("central MCP sync", () => {
  it("gates snapshot and secrets by managed node, connection, capability and first binding", async () => {
    const h = harness();
    h.setManaged(false); expect(await h.service.sendManagedNodeMcpCommand(h.nodeId)).toBe(false);
    h.setManaged(true); h.setBound(false); expect(await h.service.sendManagedNodeMcpCommand(h.nodeId)).toBe(false);
    expect(await h.service.sendManagedNodeMcpCommand("missing")).toBe(false);
    const registration = loadContractFixtures().fakeNodeReconnect.registration as NodeRegistrationPayload;
    h.registry.registerNode({ ...registration, node_id: "unsupported", capabilities: {} });
    expect(await h.service.sendManagedNodeMcpCommand("unsupported")).toBe(false);
    expect(h.snapshot).not.toHaveBeenCalled();
    h.setBound(true); expect(await h.service.sendManagedNodeMcpCommand(h.nodeId)).toBe(true);
    expect(h.sent[0]).toMatchObject({ type: "mcp_central_sync", revision: 1 });
    expect(h.sent[0]).not.toHaveProperty("mode");
    expect(h.status).toHaveBeenCalledWith(h.nodeId, expect.objectContaining({ applied_mode: "central", applied_revision: 1, activate: true, last_sync_error: null }));
  });

  it("retries a different revision and resets the connection ACK on registration", async () => {
    const h = harness();
    await h.service.sendManagedNodeMcpCommand(h.nodeId);
    expect(h.service.nodeStatus(h.nodeId).ack).toEqual({ revision: 1 });
    h.setRevision(2);
    vi.useFakeTimers();
    try {
      h.service.start();
      await vi.waitFor(() => expect(h.sent).toHaveLength(2));
      h.setRevision(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.sent).toHaveLength(3);
    } finally { h.service.stop(); vi.useRealTimers(); }
    h.service.acceptNodeEvents([{ type: "node_registered", nodeId: h.nodeId, connectionId: h.connectionId }]);
    expect(h.service.nodeStatus(h.nodeId).ack).toBeNull();
    await vi.waitFor(() => expect(h.sent).toHaveLength(4));
  });

  it("coalesces writes arriving during a node send and reads the newer revision", async () => {
    const h = harness();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = h.snapshot.getMockImplementation()!;
    h.snapshot.mockImplementationOnce(async () => { const snapshot = await original(); await blocked; return snapshot; });
    const first = h.service.sendManagedNodeMcpCommand(h.nodeId);
    await vi.waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(1));
    h.setRevision(2);
    const second = h.service.sendManagedNodeMcpCommand(h.nodeId);
    const third = h.service.sendManagedNodeMcpCommand(h.nodeId);
    release();
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(h.sent.map(message => message.revision)).toEqual([1, 2]);
  });

  it("records failure without forwarding node error text or snapshot values to logs", async () => {
    const h = harness(); h.setReject(true);
    const snapshot = await h.snapshot.getMockImplementation()!();
    h.snapshot.mockResolvedValueOnce({ ...snapshot, runtime: { ...snapshot.runtime,
      registry: { servers: [{ id: "example", header: "fake-secret-payload" }] } } });
    expect(await h.service.sendManagedNodeMcpCommand(h.nodeId)).toBe(false);
    const output = JSON.stringify([h.status.mock.calls, h.onWarning.mock.calls]);
    expect(output).toContain("MCP_PORTABLE_NODE");
    expect(output).not.toContain("fake-secret-");
  });
});
