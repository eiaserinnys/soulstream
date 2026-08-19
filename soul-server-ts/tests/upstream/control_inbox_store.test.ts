import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlInboxStore,
  canonicalControlPayloadHash,
} from "../../src/upstream/control_inbox_store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function makeStore(
  hostGeneration = "host-a",
  nowMs: () => number = () => 1_000,
): Promise<ControlInboxStore> {
  const root = await mkdtemp(join(tmpdir(), "control-inbox-"));
  roots.push(root);
  return new ControlInboxStore({
    databasePath: join(root, "_control", "control-inbox.sqlite"),
    nodeId: "node-a",
    hostGeneration,
    nowMs,
  });
}

describe("ControlInboxStore", () => {
  it("commits accepted receipts, deduplicates identical payloads, and rejects conflicts", async () => {
    const store = await makeStore();
    store.initialize();
    const command = {
      type: "intervene",
      requestId: "req-1",
      agentSessionId: "session-a",
      text: "hello",
    };

    expect(store.admit("intervention", command)).toMatchObject({
      status: "accepted",
      state: "pending",
    });
    expect(store.admit("intervention", { ...command })).toMatchObject({
      status: "duplicate",
      state: "pending",
    });
    expect(store.admit("intervention", { ...command, text: "changed" })).toMatchObject({
      status: "conflict",
      state: "pending",
    });
    expect(canonicalControlPayloadHash(command)).toMatch(/^[0-9a-f]{64}$/);
    store.close();
  });

  it("reclaims claimed work from an older host generation and preserves the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-inbox-reclaim-"));
    roots.push(root);
    const databasePath = join(root, "_control", "control-inbox.sqlite");
    const first = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => 1_000,
    });
    first.initialize();
    first.admit("session", {
      type: "interrupt_session",
      requestId: "req-2",
      agentSessionId: "session-a",
    });
    const [claimed] = first.claimPending({ leaseMs: 30_000, limit: 10 });
    expect(claimed?.state).toBe("claimed");
    first.close();

    const second = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-b",
      nowMs: () => 2_000,
    });
    expect(second.initialize()).toMatchObject({ reclaimed: 1 });
    expect(second.claimPending({ leaseMs: 30_000, limit: 10 })).toEqual([
      expect.objectContaining({
        requestId: "req-2",
        commandFamily: "session",
        command: expect.objectContaining({ type: "interrupt_session" }),
      }),
    ]);
    second.close();
  });

  it("reclaims an expired lease at startup even within the same host generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-inbox-expired-"));
    roots.push(root);
    const databasePath = join(root, "_control", "control-inbox.sqlite");
    const first = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => 1_000,
    });
    first.initialize();
    first.admit("session", {
      type: "interrupt_session",
      requestId: "req-expired",
      agentSessionId: "session-a",
    });
    first.claimPending({ leaseMs: 100, limit: 1 });
    first.close();

    const second = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => 1_101,
    });
    expect(second.initialize()).toMatchObject({ reclaimed: 1, pending: 1 });
    expect(second.claimPending({ leaseMs: 100, limit: 1 })).toEqual([
      expect.objectContaining({ requestId: "req-expired" }),
    ]);
    second.close();
  });

  it("fences a result produced by a stale host generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-inbox-fence-"));
    roots.push(root);
    const databasePath = join(root, "_control", "control-inbox.sqlite");
    const first = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => 1_000,
    });
    first.initialize();
    first.admit("intervention", {
      type: "intervene",
      requestId: "req-fence",
      agentSessionId: "session-a",
      text: "stop",
    });
    const [staleWork] = first.claimPending({ leaseMs: 30_000, limit: 1 });
    first.close();

    const second = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-b",
      nowMs: () => 2_000,
    });
    second.initialize();
    const [currentWork] = second.claimPending({ leaseMs: 30_000, limit: 1 });
    expect(() => second.complete(staleWork!, {
      type: "intervene_ack",
      requestId: "req-fence",
    })).toThrow(/claim fence rejected result/);
    expect(second.complete(currentWork!, {
      type: "intervene_ack",
      requestId: "req-fence",
    })).toMatchObject({ state: "completed" });
    second.close();
  });

  it("replays completed results until the orch receipt is acknowledged", async () => {
    const store = await makeStore();
    store.initialize();
    const command = {
      type: "apply_agent_profile_update",
      requestId: "req-3",
      profile: { id: "agent-a" },
    };
    store.admit("agent-config", command);
    const [claimed] = store.claimPending({ leaseMs: 30_000, limit: 1 });
    expect(claimed).toBeDefined();
    const result = store.complete(claimed!, {
      type: "apply_agent_profile_update_ack",
      requestId: "req-3",
      status: "ok",
    });

    expect(store.listReplayableResults()).toEqual([
      expect.objectContaining({
        resultId: result.resultId,
        requestId: "req-3",
        state: "completed",
      }),
    ]);
    expect(store.acknowledgeResult(result.resultId)).toBe(true);
    expect(store.listReplayableResults()).toEqual([]);
    expect(store.admit("agent-config", command)).toMatchObject({
      status: "duplicate",
      state: "completed",
    });
    expect(store.listReplayableResults()).toEqual([
      expect.objectContaining({ resultId: result.resultId, requestId: "req-3" }),
    ]);
    store.close();
  });
});
