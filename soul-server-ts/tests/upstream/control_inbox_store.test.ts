import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROL_INBOX_CLAIM_PENDING_SQL,
  CONTROL_INBOX_LIST_REPLAYABLE_RESULTS_SQL,
  ControlInboxStore,
  canonicalControlPayloadHash,
} from "../../src/upstream/control_inbox_store.js";

const requireNodeBuiltin = createRequire(import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
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

  it("plans the claim and replay queries through the new indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-inbox-plan-"));
    roots.push(root);
    const databasePath = join(root, "_control", "control-inbox.sqlite");
    const store = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => 1_000,
    });
    store.initialize();
    const { DatabaseSync } = requireNodeBuiltin("node:sqlite") as typeof import("node:sqlite");
    const reader = new DatabaseSync(databasePath);
    try {
      const claimPlan = reader
        .prepare(`EXPLAIN QUERY PLAN ${CONTROL_INBOX_CLAIM_PENDING_SQL}`)
        .all("node-a", 1) as Array<{ detail: string }>;
      expect(claimPlan.map((row) => row.detail).join("\n")).toContain(
        "control_inbox_node_state_created_idx",
      );

      const replayPlan = reader
        .prepare(`EXPLAIN QUERY PLAN ${CONTROL_INBOX_LIST_REPLAYABLE_RESULTS_SQL}`)
        .all("node-a") as Array<{ detail: string }>;
      expect(replayPlan.map((row) => row.detail).join("\n")).toContain(
        "control_inbox_unacked_results_idx",
      );
    } finally {
      reader.close();
      store.close();
    }
  });

  it("prunes acknowledged terminal rows older than the retention window at initialize", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-inbox-prune-"));
    roots.push(root);
    const databasePath = join(root, "_control", "control-inbox.sqlite");
    let now = 1_000;
    const first = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => now,
    });
    first.initialize();
    const command = (requestId: string) => ({
      type: "intervene",
      requestId,
      agentSessionId: "session-a",
      text: requestId,
    });
    for (const requestId of [
      "old-completed",
      "old-rejected",
      "recent-completed",
      "unacked-completed",
    ]) {
      first.admit("intervention", command(requestId));
    }
    const claimed = first.claimPending({ leaseMs: 30_000, limit: 10 });
    expect(claimed).toHaveLength(4);
    const byRequest = new Map(claimed.map((work) => [work.requestId, work]));
    const oldCompleted = first.complete(byRequest.get("old-completed")!, {
      type: "intervene_ack",
      requestId: "old-completed",
    });
    const oldRejected = first.complete(byRequest.get("old-rejected")!, {
      type: "error",
      requestId: "old-rejected",
    });
    const recentCompleted = first.complete(byRequest.get("recent-completed")!, {
      type: "intervene_ack",
      requestId: "recent-completed",
    });
    first.complete(byRequest.get("unacked-completed")!, {
      type: "intervene_ack",
      requestId: "unacked-completed",
    });
    expect(first.acknowledgeResult(oldCompleted.resultId)).toBe(true);
    expect(first.acknowledgeResult(oldRejected.resultId)).toBe(true);
    now += 7 * DAY_MS;
    expect(first.acknowledgeResult(recentCompleted.resultId)).toBe(true);
    first.admit("intervention", command("still-pending"));
    first.close();

    now = 1_000 + 8 * DAY_MS;
    const second = new ControlInboxStore({
      databasePath,
      nodeId: "node-a",
      hostGeneration: "host-a",
      nowMs: () => now,
    });
    expect(second.initialize()).toMatchObject({
      reclaimed: 0,
      pruned: 2,
      pending: 1,
      replayableResults: 1,
    });
    expect(second.listReplayableResults()).toEqual([
      expect.objectContaining({ requestId: "unacked-completed" }),
    ]);
    expect(second.claimPending({ leaseMs: 30_000, limit: 10 })).toEqual([
      expect.objectContaining({ requestId: "still-pending" }),
    ]);
    expect(second.admit("intervention", command("old-completed"))).toMatchObject({
      status: "accepted",
      state: "pending",
    });
    expect(second.admit("intervention", command("recent-completed"))).toMatchObject({
      status: "duplicate",
      state: "completed",
    });
    second.close();
  });
});
