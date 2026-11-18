import { describe, expect, it, vi } from "vitest";

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

function harness(options: {
  attemptCount?: number;
  worktreeId?: string | null;
  worktreeState?: string | null;
  error?: Error;
  response?: Record<string, unknown>;
} = {}) {
  const token = "maintenance:node-1:connection-1";
  const row = {
    delivery_id: "delivery-1",
    target_session_id: "session-1",
    completion_id: "completion-1",
    relation_key: "relation-1",
    intent: "durable_next_turn",
    source: "test",
    payload: { text: "continue" },
    created_at: new Date("2026-11-18T00:00:00Z"),
    attempt_count: options.attemptCount ?? 0,
    target_worktree_id: options.worktreeId ?? null,
    target_worktree_state: options.worktreeState ?? null,
    state: "claimed",
    attempt_token: token,
  };
  const claimPendingImmediateIntentsForNode = vi.fn().mockResolvedValue([row]);
  const retryDeliveryAttempt = vi.fn().mockResolvedValue(null);
  const markUncertain = vi.fn().mockResolvedValue(null);
  const get = vi.fn().mockResolvedValue(row);
  const route = vi.fn().mockResolvedValue({ command: { commandType: "intervene", requestId: "request-1" } });
  const send = options.error ? vi.fn().mockRejectedValue(options.error) : vi.fn().mockResolvedValue(options.response ?? { status: "ok" });
  const warn = vi.fn();
  const run = () => replayPendingImmediateDeliveriesForNode({
    nodeId: "node-1", connectionId: "connection-1", attemptTokenPrefix: "maintenance",
    deliveries: { recovery: { claimPendingImmediateIntentsForNode }, retryDeliveryAttempt, markUncertain, get } as never,
    sessionRouter: { routeExistingSessionPendingCommand: route } as never,
    sessionBridge: { sendPendingCommand: send } as never,
    warn,
  });
  return { run, token, route, send, retryDeliveryAttempt, markUncertain };
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
});
