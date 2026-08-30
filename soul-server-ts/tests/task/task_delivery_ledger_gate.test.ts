import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import type { Task } from "../../src/task/task_models.js";

function row(
  deliveryId: string,
  state: SessionDeliveryRow["state"],
  overrides: Partial<SessionDeliveryRow> = {},
): SessionDeliveryRow {
  return {
    delivery_id: deliveryId,
    target_session_id: "caller-1",
    source_session_id: null,
    relation_key: `user_message:caller-1:${deliveryId}`,
    completion_id: `message:${deliveryId}`,
    intent: "human_live_steer",
    source: "user_message",
    producer_kind: null,
    producer_id: null,
    producer_terminal_revision: null,
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: `hash:${deliveryId}`,
    payload: { text: "canonical D", user: "human" },
    state,
    aggregate_state: state === "consumed" ? "consumed" : "pending",
    created_at: new Date("2026-08-30T03:23:15.122Z"),
    updated_at: new Date("2026-08-30T03:23:15.122Z"),
    claimed_at: null,
    dispatching_at: null,
    lease_owner: null,
    lease_expires_at: null,
    attempt_count: 0,
    next_attempt_at: new Date("2026-08-30T03:23:15.122Z"),
    last_error: null,
    queued_at: null,
    delivered_at: null,
    consumed_at: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    target_receipt_id: null,
    target_receipt_at: null,
    consumed_reason: null,
    dead_letter_reason: null,
    dead_lettered_at: null,
    ...overrides,
  };
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    register: vi.fn(),
    claimForTarget: vi.fn(),
    beginDispatch: vi.fn(),
    get: vi.fn(),
    getNextAcceptedForTarget: vi.fn(),
    markQueued: vi.fn(),
    markDelivered: vi.fn(),
    markConsumed: vi.fn(),
    markConsumedByRelation: vi.fn(),
    recordRelationConsumed: vi.fn(),
    retryLeasedDelivery: vi.fn(),
    markPendingSuperseded: vi.fn(),
    notifications: {
      stageWithQueuedDelivery: vi.fn(),
      get: vi.fn(),
      markPublished: vi.fn(),
      retry: vi.fn(),
    },
    ...overrides,
  } as never;
}

function task(executionCommandId = "delivery:delivery-exact-d"): Task {
  return {
    agentSessionId: "caller-1",
    prompt: "foreground",
    status: "running",
    createdAt: new Date("2026-08-30T03:23:15.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    executionOwnership: {
      ownerKind: "runner_process",
      manifestId: "manifest-g1",
      runtimeEnvIdentity: "runtime-g1",
      ownershipGeneration: 5,
      registrationId: "registration-g1",
      pid: 4105,
      startIdentity: "start-g1",
      executionCommandId,
    },
  };
}

describe("TaskDeliveryLedgerGate exact delivery authority", () => {
  it("admits and dispatches human input as one canonical delivery", async () => {
    const deliveryId = "delivery-exact-d";
    const pending = row(deliveryId, "pending");
    const claimed = row(deliveryId, "claimed", { lease_owner: "claim-g" });
    const dispatching = row(deliveryId, "dispatching", {
      lease_owner: "claim-g",
    });
    const register = vi.fn().mockResolvedValue({
      row: pending,
      inserted: true,
      conflict: false,
    });
    const claimForTarget = vi.fn().mockResolvedValue(claimed);
    const beginDispatch = vi.fn().mockResolvedValue(dispatching);
    const gate = new TaskDeliveryLedgerGate(true, repository({
      register,
      claimForTarget,
      beginDispatch,
    }));

    const admission = await gate.admit({
      agentSessionId: "caller-1",
      text: "canonical D",
      user: "human",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:caller-1:${deliveryId}`,
      source: "user_message",
      deliveryLeaseOwner: "claim-g",
    });
    await expect(gate.beginDispatch(admission)).resolves.toMatchObject({
      kind: "admitted",
      deliveryId,
      row: { state: "dispatching", lease_owner: "claim-g" },
    });
    expect(claimForTarget).toHaveBeenCalledWith(deliveryId, "caller-1", "claim-g");
  });

  it("reconstructs next-turn input only from the canonical row", async () => {
    const canonical = row("delivery-exact-d", "queued", {
      lease_owner: "delivery:delivery-exact-d",
      payload: {
        text: "stored canonical text",
        user: "stored human",
        attachment_paths: ["/tmp/evidence.png"],
      },
    });
    const get = vi.fn().mockResolvedValue(canonical);
    const getNextAcceptedForTarget = vi.fn().mockResolvedValue(canonical);
    const gate = new TaskDeliveryLedgerGate(true, repository({
      get,
      getNextAcceptedForTarget,
    }));

    await expect(gate.nextAcceptedForTarget("caller-1")).resolves.toMatchObject({
      text: "stored canonical text",
      user: "stored human",
      attachmentPaths: ["/tmp/evidence.png"],
      deliveryId: "delivery-exact-d",
      deliveryLeaseOwner: "delivery:delivery-exact-d",
    });
    await expect(gate.acceptedDelivery(
      "delivery-exact-d",
      "caller-1",
    )).resolves.toMatchObject({
      text: "stored canonical text",
      deliveryId: "delivery-exact-d",
    });
  });

  it("projects acceptance to queued without treating it as consumption", async () => {
    const deliveryId = "delivery-exact-d";
    const markQueued = vi.fn().mockResolvedValue(row(deliveryId, "queued", {
      lease_owner: "claim-g",
    }));
    const markConsumed = vi.fn();
    const gate = new TaskDeliveryLedgerGate(true, repository({
      markQueued,
      markConsumed,
    }));

    await gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "dispatching", { lease_owner: "claim-g" }),
    }, { delivered: true });

    expect(markQueued).toHaveBeenCalledWith(deliveryId, "claim-g");
    expect(markConsumed).not.toHaveBeenCalled();
  });

  it("accepts a queued CAS miss after exact D already reached G+1 receipt", async () => {
    const deliveryId = "delivery-exact-d";
    const admissionRow = row(deliveryId, "dispatching", {
      lease_owner: "claim-g",
    });
    const consumed = row(deliveryId, "consumed", {
      lease_owner: `delivery:${deliveryId}`,
      caller_turn_id: `execution:5:delivery:${deliveryId}:first-model-event`,
    });
    const gate = new TaskDeliveryLedgerGate(true, repository({
      markQueued: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(consumed),
    }));

    await expect(gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: admissionRow,
    }, { delivered: true })).resolves.toBeUndefined();
  });

  it("rejects a queued CAS miss owned by another delivery identity", async () => {
    const deliveryId = "delivery-exact-d";
    const gate = new TaskDeliveryLedgerGate(true, repository({
      markQueued: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(row(deliveryId, "queued", {
        target_session_id: "other-session",
      })),
    }));

    await expect(gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "dispatching", { lease_owner: "claim-g" }),
    }, { delivered: true })).rejects.toThrow("lost queued-state CAS");
  });

  it("consumes exact D only through the current G+1 execution claim", async () => {
    const deliveryId = "delivery-exact-d";
    const markConsumed = vi.fn().mockResolvedValue(row(deliveryId, "consumed"));
    const gate = new TaskDeliveryLedgerGate(true, repository({ markConsumed }));
    const canonicalMessage = {
      text: "canonical D",
      user: "human",
      deliveryId,
      deliveryIntent: "human_live_steer" as const,
      deliveryLeaseOwner: `delivery:${deliveryId}`,
    };

    await gate.recordConsumed(
      canonicalMessage,
      task(),
      `execution:5:delivery:${deliveryId}:first-model-event`,
    );
    expect(markConsumed).toHaveBeenCalledWith(
      deliveryId,
      `execution:5:delivery:${deliveryId}:first-model-event`,
      `delivery:${deliveryId}`,
    );

    await expect(gate.recordConsumed(
      { ...canonicalMessage, deliveryLeaseOwner: "execution-g" },
      task(),
      "stale-g-receipt",
    )).rejects.toThrow("consumption ownership changed");
  });

  it("reserves scheduler time without creating another conversation owner", async () => {
    const deliveryId = "scheduled-delivery";
    const retryLeasedDelivery = vi.fn().mockResolvedValue(row(deliveryId, "pending"));
    const gate = new TaskDeliveryLedgerGate(true, repository({ retryLeasedDelivery }));

    await gate.reserveRetry({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "claimed", { lease_owner: "scheduler-claim" }),
    }, new Date(Date.now() + 10_000).toISOString());

    expect(retryLeasedDelivery).toHaveBeenCalledWith(
      deliveryId,
      "scheduler-claim",
      "scheduled_runtime_followup_retry",
      expect.any(Number),
    );
  });
});
