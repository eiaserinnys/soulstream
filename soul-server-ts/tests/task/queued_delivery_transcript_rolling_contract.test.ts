import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";

type LedgerState = "claimed" | "delivered" | "consumed" | "queued";

describe("queued transcript recovery rolling contract", () => {
  it("new soul converges with an old orch through the legacy delivered action", async () => {
    const harness = makeHarness("old_orch");

    await expect(harness.recovery.recoverAfterNodeRestart("node-a")).resolves.toBe(1);
    await harness.assertExactlyOnce();
  });

  it("new soul converges with a new orch whose legacy response remains delivered", async () => {
    const harness = makeHarness("new_orch");

    await expect(harness.recovery.recoverAfterNodeRestart("node-a")).resolves.toBe(1);
    await harness.assertExactlyOnce();
  });

  it("returns transcript-absent input to pending for reconnect reclaim", async () => {
    const harness = makeDeferredHarness("absent");

    await expect(harness.recovery.recoverAfterNodeRestart("node-a")).resolves.toBe(0);
    expect(harness.retryLeasedDelivery).toHaveBeenCalledWith(
      "delivery-deferred",
      "rolling-worker",
      "queued_transcript_input_absent",
      1_000,
    );
    expect(harness.deferQueuedTranscriptCheck).not.toHaveBeenCalled();
  });

  it("keeps transcript-pending input queued for receipt recheck", async () => {
    const harness = makeDeferredHarness("input_pending");

    await expect(harness.recovery.recoverAfterNodeRestart("node-a")).resolves.toBe(0);
    expect(harness.deferQueuedTranscriptCheck).toHaveBeenCalledWith(
      "delivery-deferred",
      "rolling-worker",
      "queued_transcript_input_pending",
      1_000,
    );
    expect(harness.retryLeasedDelivery).not.toHaveBeenCalled();
  });
});

function makeDeferredHarness(receiptKind: "absent" | "input_pending") {
  const claimedRow = {
    delivery_id: "delivery-deferred",
    state: "claimed",
    lease_owner: "rolling-worker",
  } as SessionDeliveryRow;
  const retryLeasedDelivery = vi.fn(async () => ({
    ...claimedRow,
    state: "pending",
    lease_owner: null,
  }) as SessionDeliveryRow);
  const deferQueuedTranscriptCheck = vi.fn(async () => ({
    ...claimedRow,
    state: "queued",
    lease_owner: null,
  }) as SessionDeliveryRow);
  const recovery = new QueuedDeliveryTranscriptRecovery({
    deliveryRepository: {
      get: vi.fn(async () => claimedRow),
      markConsumed: vi.fn(async () => null),
      retryLeasedDelivery,
    },
    recoveryRepository: {
      claimQueuedAfterNodeRestart: vi.fn(async () => [claimedRow]),
      markDeliveredFromTranscript: vi.fn(async () => null),
      deferQueuedTranscriptCheck,
    },
    transcriptReceipt: {
      inspect: vi.fn(async () => ({
        kind: receiptKind,
        inputUuid: "delivery:delivery-deferred",
      })),
    },
    logger: { warn: vi.fn() },
  } as never, "rolling-worker");

  return {
    recovery,
    retryLeasedDelivery,
    deferQueuedTranscriptCheck,
  };
}

function makeHarness(orchVersion: "old_orch" | "new_orch") {
  let state: LedgerState = "claimed";
  let receiptId: string | null = null;
  let deliveredTransitions = 0;
  let consumedTransitions = 0;
  let claimed = false;

  const row = (): SessionDeliveryRow => ({
    delivery_id: "delivery-rolling",
    relation_key: "relation-rolling",
    completion_id: "completion-rolling",
    intent: "human_live_steer",
    source: "user_message",
    producer_kind: null,
    producer_id: null,
    producer_terminal_revision: null,
    target_session_id: "session-rolling",
    target_node_id: "node-a",
    state,
    aggregate_state: state === "consumed" ? "consumed" : state,
    disposition: "queued",
    payload_hash: "hash-rolling",
    payload: { text: "keep this steer", user: "alice", source: "user_message" },
    caller_turn_id: receiptId,
    target_receipt_id: receiptId,
    target_receipt_at: receiptId ? new Date("2026-08-24T15:50:09.000Z") : null,
    claimed_at: new Date("2026-08-24T15:50:08.000Z"),
    dispatching_at: null,
    delivered_at: state === "delivered" || state === "consumed"
      ? new Date("2026-08-24T15:50:09.000Z")
      : null,
    consumed_at: state === "consumed"
      ? new Date("2026-08-24T15:50:09.100Z")
      : null,
    consumed_reason: null,
    lease_owner: state === "claimed" ? "rolling-worker" : null,
    lease_expires_at: state === "claimed"
      ? new Date("2026-08-24T15:51:08.000Z")
      : null,
    attempt_count: 0,
    next_attempt_at: new Date("2026-08-24T15:50:08.000Z"),
    last_error: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    created_at: new Date("2026-08-24T15:50:08.000Z"),
    updated_at: new Date("2026-08-24T15:50:09.100Z"),
  });

  const recoveryRepository = {
    claimQueuedAfterNodeRestart: vi.fn(async () => {
      if (claimed || state !== "claimed") return [];
      claimed = true;
      return [row()];
    }),
    claimRecoverableQueued: vi.fn(async () => []),
    markDeliveredFromTranscript: vi.fn(async (
      _deliveryId: string,
      _leaseOwner: string,
      assistantMessageUuid: string,
    ) => {
      if (state !== "claimed") return null;
      receiptId = `transcript:${assistantMessageUuid}`;
      state = "delivered";
      deliveredTransitions += 1;
      const legacyResponse = row();
      if (orchVersion === "new_orch") {
        state = "consumed";
        consumedTransitions += 1;
      }
      return legacyResponse;
    }),
    markConsumedFromTranscript: vi.fn(async () => {
      throw new Error("unsupported operation: mark_consumed_from_transcript");
    }),
    deferQueuedTranscriptCheck: vi.fn(async () => {
      state = "queued";
      return row();
    }),
  };
  const deliveryRepository = {
    retryLeasedDelivery: vi.fn(async () => null),
    markConsumed: vi.fn(async (_deliveryId: string, consumedTurnId: string) => {
      if (state !== "delivered" || consumedTurnId !== receiptId) return null;
      state = "consumed";
      consumedTransitions += 1;
      return row();
    }),
    get: vi.fn(async () => row()),
  };
  const recovery = new QueuedDeliveryTranscriptRecovery({
    deliveryRepository,
    recoveryRepository,
    transcriptReceipt: {
      inspect: vi.fn(async () => ({
        kind: "completed" as const,
        inputUuid: "delivery:delivery-rolling",
        assistantMessageUuid: "assistant-rolling",
      })),
    },
    logger: { warn: vi.fn() },
  } as never, "rolling-worker");

  return {
    recovery,
    async assertExactlyOnce() {
      expect(state).toBe("consumed");
      expect(deliveredTransitions).toBe(1);
      expect(consumedTransitions).toBe(1);
      expect(recoveryRepository.markDeliveredFromTranscript).toHaveBeenCalledOnce();
      expect(recoveryRepository.markConsumedFromTranscript).not.toHaveBeenCalled();
      expect(deliveryRepository.retryLeasedDelivery).not.toHaveBeenCalled();
      await expect(recovery.recoverAfterNodeRestart("node-a")).resolves.toBe(0);
      expect(deliveredTransitions).toBe(1);
      expect(consumedTransitions).toBe(1);
    },
  };
}
