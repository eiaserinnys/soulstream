import { describe, expect, it, vi } from "vitest";
import { createSessionReconciliationSink } from "../src/node/session_reconciliation_sink.js";
import { InMemoryNodeRegistry } from "../src/node/registry.js";

function fixture() {
  let connectionId = "first";
  const targets = [{ sessionId: "old", updatedAt: "2026-10-01 00:00:00.123456+00", status: "initializing" as const,
    executionRegistrationId: null, executionCommandId: null }];
  const repository = {
    captureNodeStartupTargets: vi.fn(async () => targets),
    reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    reconcileNodeDisconnected: vi.fn(async () => 0),
  };
  const replies: Array<(value: { requestId: string; runningSessionIds: string[] }) => void> = [];
  const request = vi.fn(() => new Promise<{ requestId: string; runningSessionIds: string[] }>((resolve) => replies.push(resolve)));
  const errors = vi.fn();
  const sink = createSessionReconciliationSink({
    repositoryProvider: async () => repository, requestSessionInventory: request,
    getConnectedNode: () => ({ connectionId }), logError: errors,
  });
  const connect = (id: string) => {
    connectionId = id;
    sink([{ type: "node_registered", nodeId: "node", connectionId }]);
  };
  return { sink, connect, repository, request, replies, errors, targets, setConnection: (id: string) => { connectionId = id; } };
}

describe("startup inventory request scope", () => {
  it("finishes the DB snapshot before emitting the connection-scoped request", async () => {
    const f = fixture();
    let finish!: (value: typeof f.targets) => void;
    f.repository.captureNodeStartupTargets.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    f.connect("first");
    await vi.waitFor(() => expect(f.repository.captureNodeStartupTargets).toHaveBeenCalledOnce());
    expect(f.request).not.toHaveBeenCalled();
    finish(f.targets);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("node", "first"));
    f.replies[0]!({ requestId: "first-request", runningSessionIds: [] });
    await vi.waitFor(() => expect(f.repository.reconcileNodeStartup).toHaveBeenCalledWith("node", [], expect.any(Date), f.targets));
    await f.sink.close();
    expect(f.errors).not.toHaveBeenCalled();
  });

  it("does not send a captured snapshot on a changed generation", async () => {
    const f = fixture();
    let finish!: (value: typeof f.targets) => void;
    f.repository.captureNodeStartupTargets.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    f.connect("first");
    await vi.waitFor(() => expect(f.repository.captureNodeStartupTargets).toHaveBeenCalledOnce());
    f.setConnection("second");
    finish(f.targets);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.request).not.toHaveBeenCalled();
    expect(f.repository.reconcileNodeStartup).not.toHaveBeenCalled();
    await f.sink.close();
  });

  it("ignores an old response, applies the current request once, and gives unsolicited duplicates no targets", async () => {
    const f = fixture();
    f.connect("first");
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    f.connect("second");
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    f.replies[0]!({ requestId: "old-request", runningSessionIds: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.repository.reconcileNodeStartup).not.toHaveBeenCalled();
    f.replies[1]!({ requestId: "current-request", runningSessionIds: [] });
    await vi.waitFor(() => expect(f.repository.reconcileNodeStartup).toHaveBeenCalledTimes(1));
    f.sink([{ type: "node_runner_inventory", nodeId: "node", data: { requestId: "current-request", running_session_ids: [] } }]);
    await vi.waitFor(() => expect(f.repository.reconcileNodeStartup).toHaveBeenCalledTimes(2));
    expect(f.repository.reconcileNodeStartup.mock.calls.map((args) => args.length)).toEqual([4, 3]);
    await f.sink.close();
  });

  it("uses the existing pending request identity for both inventory shapes and rejects old connections", async () => {
    for (const type of ["list_runner_inventory", "list_sessions"] as const) {
      const registry = new InMemoryNodeRegistry();
      const first = registry.registerNode({ type: "node_register", node_id: "node" });
      const command = registry.createCommand("node", { type });
      const response = { type: type === "list_sessions" ? "sessions_update" : "runner_inventory",
        requestId: command.requestId, running_session_ids: [], sessions: [{ agentSessionId: "visible", status: "running" }] };
      expect(registry.receiveNodeMessage({ nodeId: "node", connectionId: "older" }, response)[0]?.type)
        .toBe("ignored_stale_message");
      expect(registry.getConnectedNode("node")?.pendingCommandCount).toBe(1);
      const events = registry.receiveNodeMessage({ nodeId: "node", connectionId: first.node.connectionId }, response);
      expect(await command.result).toEqual(response);
      expect(events.map((event) => event.type)).toEqual(["command_ack", type === "list_sessions" ? "node_session_sessions_update" : "node_runner_inventory"]);
      expect(registry.getConnectedNode("node")?.pendingCommandCount).toBe(0);
      if (type === "list_sessions") expect(registry.sessionCache.findSession("visible")?.status).toBe("running");
    }
  });
});
