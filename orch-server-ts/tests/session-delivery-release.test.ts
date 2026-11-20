import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "@soulstream/wire-schema/session-delivery";
import {
  DELIVERY_CLAIM_TTL_MS,
  isExplicitNodeRejection,
  nodeRejectionDetailsSuffix,
  releaseDeliveryAttemptAfterSendFailure,
} from "../src/control_plane/session_delivery_release.js";
import { DEFAULT_NODE_COMMAND_TIMEOUT_MS } from "../src/node/node_timeouts.js";
import { PendingNodeCommandRejectedError } from "../src/node/pending_commands.js";

const TOKEN = "maintenance:node-1:connection-1";

function row(overrides: Record<string, unknown> = {}): SessionDeliveryRow {
  return {
    delivery_id: "delivery-1",
    state: "claimed",
    aggregate_state: "pending",
    attempt_token: TOKEN,
    attempt_count: 0,
    ...overrides,
  } as SessionDeliveryRow;
}

function rejection(
  details?: Record<string, unknown>,
  code = "NODE_RESPONSE_REJECTED",
): PendingNodeCommandRejectedError {
  return new PendingNodeCommandRejectedError({
    commandType: "intervene",
    requestId: "request-1",
    message: "resume rejected",
    response: { type: "error", code, ...(details ? { details } : {}) },
  });
}

function harness(current: SessionDeliveryRow | null = row()) {
  const get = vi.fn().mockResolvedValue(current);
  const retryDeliveryAttempt = vi.fn().mockResolvedValue(null);
  const markUncertain = vi.fn().mockResolvedValue(null);
  const run = (error: unknown, attemptCount = 0) =>
    releaseDeliveryAttemptAfterSendFailure({
      repository: { get, retryDeliveryAttempt, markUncertain } as never,
      deliveryId: "delivery-1",
      attemptToken: TOKEN,
      error,
      failure: `maintenance delivery delivery-1 dispatch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      attemptCount,
    });
  return { run, get, retryDeliveryAttempt, markUncertain };
}

describe("delivery claim window", () => {
  it("outlives the node command wait by five seconds", () => {
    expect(DELIVERY_CLAIM_TTL_MS).toBe(DEFAULT_NODE_COMMAND_TIMEOUT_MS + 5_000);
  });
});

describe("delivery attempt release after a send failure", () => {
  it.each([[0, 60_000], [1, 120_000], [2, 240_000], [4, 600_000], [9, 600_000]])(
    "backs off an explicit retryable rejection at attempt %i by %i ms",
    async (attemptCount, delay) => {
      const h = harness();
      await h.run(rejection({ reason: "worktree_not_ready", cell: "retryable" }), attemptCount);
      expect(h.retryDeliveryAttempt).toHaveBeenCalledWith(
        "delivery-1",
        TOKEN,
        expect.stringContaining("dispatch failed"),
        delay,
      );
      expect(h.markUncertain).not.toHaveBeenCalled();
    },
  );

  it.each(["permanent", "no_retry"])("dead letters a %s node rejection", async (cell) => {
    const h = harness();
    await h.run(rejection({ reason: "already_terminal", cell }));
    expect(h.markUncertain).toHaveBeenCalledWith(
      "delivery-1",
      TOKEN,
      expect.stringContaining("dispatch failed"),
    );
    expect(h.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("backs off a rejection without details on the same ladder", async () => {
    const h = harness();
    await h.run(rejection(), 3);
    expect(h.retryDeliveryAttempt).toHaveBeenCalledWith(
      "delivery-1",
      TOKEN,
      expect.not.stringContaining("reason="),
      480_000,
    );
  });

  it("keeps zero delay for failures without a node response", async () => {
    const h = harness();
    await h.run(new Error("connection lost"), 4);
    expect(h.retryDeliveryAttempt).toHaveBeenCalledWith(
      "delivery-1",
      TOKEN,
      expect.stringContaining("connection lost"),
      0,
    );
  });

  it("leaves a row that moved on (queued) untouched", async () => {
    const h = harness(row({ state: "queued" }));
    await expect(h.run(rejection({ cell: "retryable" }))).resolves.toBe("unchanged");
    expect(h.retryDeliveryAttempt).not.toHaveBeenCalled();
    expect(h.markUncertain).not.toHaveBeenCalled();
  });

  it("leaves a row claimed under a different token untouched", async () => {
    const h = harness(row({ attempt_token: "route:someone-else" }));
    await expect(h.run(rejection({ cell: "permanent" }))).resolves.toBe("unchanged");
    expect(h.retryDeliveryAttempt).not.toHaveBeenCalled();
    expect(h.markUncertain).not.toHaveBeenCalled();
  });

  it("treats only rejections with a node response as explicit", () => {
    expect(isExplicitNodeRejection(rejection())).toBe(true);
    expect(isExplicitNodeRejection(new PendingNodeCommandRejectedError({
      commandType: "intervene",
      requestId: "request-1",
      message: "Node disconnected",
    }))).toBe(false);
    expect(isExplicitNodeRejection(new Error("connection lost"))).toBe(false);
  });

  it("summarizes node rejection details for the attempt record", () => {
    expect(nodeRejectionDetailsSuffix(rejection({ reason: "already_terminal", cell: "no_retry" })))
      .toBe(" (reason=already_terminal, cell=no_retry)");
    expect(nodeRejectionDetailsSuffix(new Error("connection lost"))).toBe("");
  });
});
