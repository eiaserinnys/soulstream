import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../src/control_plane/control_plane_types.js";
import { DELIVERY_CLAIM_TTL_MS } from "../src/control_plane/session_delivery_release.js";
import { DEFAULT_NODE_COMMAND_TIMEOUT_MS } from "../src/node/node_timeouts.js";
import { replayPendingImmediateDeliveriesForNode } from "../src/production.js";
import { PendingNodeCommandRejectedError } from "../src/node/pending_commands.js";

function rejection(details?: Record<string, unknown>) {
  return new PendingNodeCommandRejectedError({
    commandType: "intervene",
    requestId: "request-1",
    message: "resume rejected",
    response: { type: "error", code: "NODE_RESPONSE_REJECTED", ...(details ? { details } : {}) },
  });
}

function replayRow(id = "delivery-1", options: {
  attemptCount?: number;
  worktreeId?: string | null;
  worktreeState?: string | null;
} = {}): SessionDeliveryRow & {
  target_worktree_id: string | null;
  target_worktree_state: string | null;
} {
  return {
    delivery_id: id,
    target_session_id: "session-1",
    completion_id: "completion-1",
    relation_key: `relation-${id}`,
    intent: "durable_next_turn",
    source: "test",
    payload: { text: "continue" },
    created_at: new Date("2026-11-18T00:00:00Z"),
    attempt_count: options.attemptCount ?? 0,
    target_worktree_id: options.worktreeId ?? null,
    target_worktree_state: options.worktreeState ?? null,
    state: "claimed",
    attempt_token: "maintenance:node-1:connection-1",
  } as unknown as SessionDeliveryRow & {
    target_worktree_id: string | null;
    target_worktree_state: string | null;
  };
}

function harness(options: {
  attemptCount?: number;
  worktreeId?: string | null;
  worktreeState?: string | null;
  error?: Error;
  response?: Record<string, unknown>;
  rows?: SessionDeliveryRow[];
} = {}) {
  const token = "maintenance:node-1:connection-1";
  const rows = options.rows ?? [replayRow("delivery-1", {
    attemptCount: options.attemptCount,
    worktreeId: options.worktreeId,
    worktreeState: options.worktreeState,
  })];
  const claimPendingImmediateIntentsForNode = vi.fn();
  for (const row of rows) {
    claimPendingImmediateIntentsForNode.mockResolvedValueOnce([row]);
  }
  claimPendingImmediateIntentsForNode.mockResolvedValue([]);
  const retryDeliveryAttempt = vi.fn().mockResolvedValue(null);
  const markUncertain = vi.fn().mockResolvedValue(null);
  const get = vi.fn(async (deliveryId: string) =>
    rows.find((row) => row.delivery_id === deliveryId) ?? null);
  const route = vi.fn().mockResolvedValue({ command: { commandType: "intervene", requestId: "request-1" } });
  const send = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : vi.fn().mockResolvedValue(options.response ?? { status: "ok" });
  const warn = vi.fn();
  const run = () => replayPendingImmediateDeliveriesForNode({
    nodeId: "node-1", connectionId: "connection-1", attemptTokenPrefix: "maintenance",
    deliveries: { recovery: { claimPendingImmediateIntentsForNode }, retryDeliveryAttempt, markUncertain, get } as never,
    sessionRouter: { routeExistingSessionPendingCommand: route } as never,
    sessionBridge: { sendPendingCommand: send } as never,
    warn,
  });
  return {
    run, token, route, send, claim: claimPendingImmediateIntentsForNode,
    retryDeliveryAttempt, markUncertain,
  };
}

describe("pending immediate delivery replay", () => {
  it.each(["removed", null])("dead letters a removed or missing target worktree (%s) before sending", async (state) => {
    const h = harness({ worktreeId: "worktree-1", worktreeState: state });
    await h.run();
    expect(h.route).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.markUncertain).toHaveBeenCalledOnce();
    expect(h.markUncertain).toHaveBeenCalledWith("delivery-1", h.token, expect.stringContaining("target session worktree removed: worktree-1"));
    expect(h.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("still sends while a worktree is removing", async () => {
    const h = harness({ worktreeId: "worktree-1", worktreeState: "removing" });
    await h.run();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.markUncertain).not.toHaveBeenCalled();
  });

  it.each([[0, 60_000], [1, 120_000], [2, 240_000], [3, 480_000], [4, 600_000], [5, 600_000]])(
    "backs off a retryable node rejection at attempt %i by %i ms", async (attemptCount, delay) => {
      const h = harness({ attemptCount, error: rejection({ reason: "worktree_not_ready", cell: "retryable", intents: ["retry_later"] }) });
      await h.run();
      expect(h.retryDeliveryAttempt).toHaveBeenCalledWith("delivery-1", h.token,
        expect.stringContaining("(reason=worktree_not_ready, cell=retryable)"), delay);
      expect(h.markUncertain).not.toHaveBeenCalled();
    },
  );

  it.each(["no_retry", "permanent"])("dead letters a %s node rejection", async (cell) => {
    const h = harness({ error: rejection({ reason: "already_terminal", cell, intents: ["abandon_attempt"] }) });
    await h.run();
    expect(h.markUncertain).toHaveBeenCalledWith("delivery-1", h.token,
      expect.stringContaining(`(reason=already_terminal, cell=${cell})`));
    expect(h.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("backs off old node rejections without details", async () => {
    const h = harness({ attemptCount: 2, error: rejection() });
    await h.run();
    expect(h.retryDeliveryAttempt).toHaveBeenCalledWith("delivery-1", h.token, expect.not.stringContaining("reason="), 240_000);
  });

  it("handles an error response returned by the bridge as a node rejection", async () => {
    const h = harness({ response: { type: "error", message: "resume rejected", code: "NODE_RESPONSE_REJECTED",
      details: { reason: "already_terminal", cell: "no_retry", intents: ["abandon_attempt"] } } });
    await h.run();
    expect(h.markUncertain).toHaveBeenCalledWith("delivery-1", h.token,
      expect.stringContaining("(reason=already_terminal, cell=no_retry)"));
    expect(h.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("keeps zero delay for transport errors", async () => {
    const h = harness({ attemptCount: 2, error: new Error("connection lost") });
    await h.run();
    expect(h.retryDeliveryAttempt).toHaveBeenCalledWith("delivery-1", h.token, expect.stringContaining("connection lost"), 0);
  });

  it("keeps zero delay when a pending command is rejected by a disconnect without a node response", async () => {
    const h = harness({ attemptCount: 2, error: new PendingNodeCommandRejectedError({
      commandType: "intervene", requestId: "request-1", message: "Node disconnected",
    }) });
    await h.run();
    expect(h.retryDeliveryAttempt).toHaveBeenCalledWith("delivery-1", h.token, expect.stringContaining("Node disconnected"), 0);
  });

  it("claims and sends one delivery at a time, alternating in enqueue order", async () => {
    const h = harness({ rows: [replayRow("delivery-1"), replayRow("delivery-2")] });
    await h.run();
    expect(h.route.mock.calls.map((call) => (call[0] as { delivery_id?: string }).delivery_id))
      .toEqual(["delivery-1", "delivery-2"]);
    const claims = h.claim.mock.invocationCallOrder;
    const sends = h.send.mock.invocationCallOrder;
    expect(claims).toHaveLength(3);
    expect(claims[0]).toBeLessThan(sends[0]!);
    expect(sends[0]).toBeLessThan(claims[1]!);
    expect(claims[1]).toBeLessThan(sends[1]!);
    expect(sends[1]).toBeLessThan(claims[2]!);
  });

  it("claims with the node command wait plus five seconds and skips rows already attempted this pass", async () => {
    const h = harness();
    await h.run();
    expect(DELIVERY_CLAIM_TTL_MS).toBe(DEFAULT_NODE_COMMAND_TIMEOUT_MS + 5_000);
    expect(h.claim.mock.calls).toEqual([
      ["node-1", h.token, 1, DELIVERY_CLAIM_TTL_MS, []],
      ["node-1", h.token, 1, DELIVERY_CLAIM_TTL_MS, ["delivery-1"]],
    ]);
  });

  it("stops at one hundred deliveries per pass", async () => {
    const h = harness({
      rows: Array.from({ length: 120 }, (_, index) => replayRow(`delivery-${index}`)),
    });
    await h.run();
    expect(h.send).toHaveBeenCalledTimes(100);
    expect(h.claim).toHaveBeenCalledTimes(100);
  });
});
