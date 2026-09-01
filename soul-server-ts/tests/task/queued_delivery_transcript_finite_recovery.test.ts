import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { ClaudeRuntimeStartupRecovery } from
  "../../src/runtime/claude_runtime_startup_recovery.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("queued transcript finite restart recovery", () => {
  it("returns input-pending identity once and does not reselect it in the same boot", async () => {
    const harness = makeHarness("input_pending");

    await harness.startup.start();
    await afterRunnerRecovery(harness.startup);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);

    expect(harness.state()).toBe("pending");
    expect(harness.claimQueuedAfterNodeRestart).toHaveBeenCalledOnce();
    expect(harness.inspect).toHaveBeenCalledOnce();
    expect(harness.retryLeasedDelivery).toHaveBeenCalledOnce();
    expect(harness.retryLeasedDelivery).toHaveBeenCalledWith(
      harness.deliveryId,
      "startup-worker",
      "queued_transcript_input_pending",
      0,
    );
    expect(buildDeliveryInputUuid(harness.deliveryId)).toBe(harness.inputUuid);
    await harness.startup.stop();
  });

  it("consumes a transcript-completed delivery exactly once before retiring", async () => {
    const harness = makeHarness("completed");

    await harness.startup.start();
    await afterRunnerRecovery(harness.startup);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);

    expect(harness.state()).toBe("consumed");
    expect(harness.claimQueuedAfterNodeRestart).toHaveBeenCalledOnce();
    expect(harness.inspect).toHaveBeenCalledOnce();
    expect(harness.markConsumed).toHaveBeenCalledOnce();
    expect(harness.retryLeasedDelivery).not.toHaveBeenCalled();
    await harness.startup.stop();
  });
});

function makeHarness(receiptKind: "input_pending" | "completed") {
  vi.useFakeTimers();
  const deliveryId = `delivery-${receiptKind}`;
  const inputUuid = buildDeliveryInputUuid(deliveryId);
  let state: "queued" | "claimed" | "pending" | "delivered" | "consumed" = "queued";
  let receiptId: string | null = null;
  const row = (): SessionDeliveryRow => ({
    delivery_id: deliveryId,
    state,
    aggregate_state: state === "consumed" ? "consumed" : "pending",
    lease_owner: state === "claimed" ? "startup-worker" : null,
    target_receipt_id: receiptId,
  }) as SessionDeliveryRow;
  const claimQueuedAfterNodeRestart = vi.fn(async () => {
    if (state !== "queued") return [];
    state = "claimed";
    return [row()];
  });
  const retryLeasedDelivery = vi.fn(async () => {
    if (state !== "claimed") return null;
    state = "pending";
    return row();
  });
  const markDeliveredFromTranscript = vi.fn(async (
    _deliveryId: string,
    _leaseOwner: string,
    assistantMessageUuid: string,
  ) => {
    if (state !== "claimed") return null;
    receiptId = `transcript:${assistantMessageUuid}`;
    state = "delivered";
    return row();
  });
  const markConsumed = vi.fn(async () => {
    if (state !== "delivered") return null;
    state = "consumed";
    return row();
  });
  const inspect = vi.fn(async () => receiptKind === "completed"
    ? {
        kind: "completed" as const,
        inputUuid,
        assistantMessageUuid: "assistant-restart-proof",
      }
    : { kind: "input_pending" as const, inputUuid });
  const queuedRecovery = new QueuedDeliveryTranscriptRecovery({
    deliveryRepository: {
      get: vi.fn(async () => row()),
      markConsumed,
      retryLeasedDelivery,
    },
    recoveryRepository: {
      claimQueuedAfterNodeRestart,
      markDeliveredFromTranscript,
      deferQueuedTranscriptCheck: vi.fn(async () => {
        state = "queued";
        return row();
      }),
    },
    transcriptReceipt: { inspect },
    logger: { warn: vi.fn() },
  } as never, "startup-worker");
  const startup = new ClaudeRuntimeStartupRecovery(
    {
      recoverQueuedDeliveries: () =>
        queuedRecovery.recoverAfterNodeRestart("node-a"),
      recoverBackgroundTasks: vi.fn(async () => 0),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nodeId: "node-a",
    },
    50,
  );
  return {
    deliveryId,
    inputUuid,
    startup,
    state: () => state,
    claimQueuedAfterNodeRestart,
    inspect,
    markConsumed,
    retryLeasedDelivery,
  };
}

async function afterRunnerRecovery(
  startup: ClaudeRuntimeStartupRecovery,
): Promise<void> {
  await startup.afterRunnerRecovery();
}
