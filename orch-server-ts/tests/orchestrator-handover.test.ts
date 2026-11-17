import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionStore } from "../src/external_events/store.js";
import { OrchestratorHandover, type HandoverLocks } from "../src/runtime/orchestrator_handover.js";
import { HandoverGate } from "../src/runtime/handover_gate.js";
import { InMemoryNodeRegistry, type NodeRegistrationPayload } from "../src/node/registry.js";
import { SessionCommandRouter, SessionRouteNoAvailableNodesError } from "../src/session/session_command_router.js";
import { createSessionReconciliationSink } from "../src/node/session_reconciliation_sink.js";

it("waits for node registration and preserves the normal error after ten seconds", async () => {
  vi.useFakeTimers();
  try {
    const registry = new InMemoryNodeRegistry();
    registry.beginHandoverNodeWait();
    const waiting = registry.waitForNode("node-a");
    registry.registerNode({ type: "node_register", node_id: "node-a", host: "", port: 0, agents: [] } as NodeRegistrationPayload);
    await waiting;
    expect(registry.getConnectedNode("node-a")).toBeDefined();
    const empty = new InMemoryNodeRegistry(); empty.beginHandoverNodeWait();
    const timeout = empty.waitForNode();
    await vi.advanceTimersByTimeAsync(10_000); await timeout;
    expect(() => new SessionCommandRouter({ registry: empty }).createSession({ type: "create_session", agentSessionId: "id", prompt: "x" })).toThrow(SessionRouteNoAvailableNodesError);
  } finally { vi.useRealTimers(); }
});

it("ignores the node disconnect caused by handover after reconciliation closes", async () => {
  const reconcileNodeDisconnected = vi.fn(async () => 0);
  const sink = createSessionReconciliationSink({ repositoryProvider: async () => ({
    reconcileNodeDisconnected, reconcileNodeStartup: async () => ({ interrupted: 0, restored: 0 }),
  }), logError: vi.fn() });
  await sink.close();
  sink([{ type: "node_unregistered", nodeId: "node-a", connectionId: "one", reason: "websocket_close" } as never]);
  await Promise.resolve();
  expect(reconcileNodeDisconnected).not.toHaveBeenCalled();
});

it("waits for page ownership and rejects later opens after release", async () => {
  const gate = new HandoverGate();
  const open = vi.fn(async () => "page");
  const result = gate.run(open);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(open).not.toHaveBeenCalled();
  gate.open();
  await expect(result).resolves.toBe("page");
  await gate.close();
  await expect(gate.run(open)).rejects.toMatchObject({ statusCode: 503 });
});

it("reclaims owner when the successor never becomes ready and releases the lock", async () => {
  const events: string[] = [];
  let receive!: (message: string) => void;
  let canAcquire = true;
  const locks: HandoverLocks = {
    subscribe: async fn => { receive = fn; }, tryOwner: async () => canAcquire,
    releaseOwner: async () => { events.push("release"); canAcquire = true; },
    acquirePage: async () => {}, releasePage: async () => { events.push("page-release"); },
    notify: async () => {}, close: async () => {},
  };
  const handover = new OrchestratorHandover(locks, {
    start: async () => {}, stopBackground: async () => { events.push("stop"); },
    resumeBackground: async () => { events.push("resume"); }, stopListening: () => { events.push("stop-listening"); },
    drainCommands: async () => {}, closeNodeSockets: () => {}, closePages: async () => {},
    closeHttp: async () => {}, exit: () => {}, log: () => {},
  }, 5, 20);
  await handover.start();
  receive("request");
  await vi.waitFor(() => expect(events).toContain("resume"));
  expect(events).toEqual(["stop", "release", "resume"]);
  await handover.close();
});

it("waits for ownership and finishes the old generation after successor readiness", async () => {
  const events: string[] = [];
  let receive!: (message: string) => void;
  let ownerAvailable = false;
  const locks: HandoverLocks = {
    subscribe: async fn => { receive = fn; }, tryOwner: async () => ownerAvailable,
    releaseOwner: async () => { events.push("release-owner"); ownerAvailable = false; },
    acquirePage: async () => { events.push("page-lock"); }, releasePage: async () => { events.push("release-page"); },
    notify: async message => { events.push(message); }, close: async () => {},
  };
  const handover = new OrchestratorHandover(locks, {
    start: async () => { events.push("start-and-listen"); }, stopBackground: async () => { events.push("stop-background"); },
    resumeBackground: async () => { events.push("resume-background"); }, stopListening: () => { events.push("stop-listening"); },
    drainCommands: async () => { events.push("commands"); }, closeNodeSockets: () => { events.push("node-1012"); },
    closePages: async () => { events.push("pages-saved"); }, closeHttp: async () => { events.push("http-closed"); },
    exit: () => { events.push("exit-0"); }, log: () => {},
  }, 10, 1000);
  const starting = handover.start();
  await vi.waitFor(() => expect(events).toContain("request"));
  expect(events).not.toContain("start-and-listen");
  ownerAvailable = true; await starting;
  expect(events.slice(-3)).toEqual(["start-and-listen", "ready", "page-lock"]);
  receive("request");
  await vi.waitFor(() => expect(events).toContain("release-owner"));
  expect(events.indexOf("stop-background")).toBeLessThan(events.indexOf("release-owner"));
  expect(events).not.toContain("stop-listening");
  receive("ready");
  await vi.waitFor(() => expect(events).toContain("exit-0"));
  expect(events.slice(events.indexOf("stop-listening"))).toEqual([
    "stop-listening", "commands", "node-1012", "pages-saved", "release-page", "http-closed", "exit-0",
  ]);
});

describe("handover whole-file state", () => {
  it("drains old writes before a successor reads and rejects old writes until resumed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "events-handover-"));
    const file = join(dir, "state.json");
    const record = (id: string) => ({ id, owner: "owner", arguments: { recipient_label: id },
      callback: "https://example.test/hook", secret: "whsec_" + Buffer.alloc(24).toString("base64"),
      expiresAt: 9999999999999, active: true, verifiedAt: 1 });
    try {
      const old = await SubscriptionStore.open(file);
      const pending = old.update("old", () => record("old"));
      await old.pauseWrites();
      await pending;
      await expect(old.update("later", () => record("later"))).rejects.toMatchObject({ statusCode: 503 });
      const next = await SubscriptionStore.open(file);
      await next.update("new", () => record("new"));
      expect(JSON.parse(await readFile(file, "utf8")).subscriptions.map((r: {id: string}) => r.id).sort()).toEqual(["new", "old"]);
      old.resumeWrites();
      await expect(old.update("later", () => record("later"))).resolves.toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
