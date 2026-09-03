import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { ClaudeRuntimeStartupRecovery } from
  "../../src/runtime/claude_runtime_startup_recovery.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";
import { TaskDeliveryConsumption } from
  "../../src/task/task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from
  "../../src/task/task_delivery_turn_receipt.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("queued transcript finite restart recovery", () => {
  it("returns input-pending identity once and does not reselect it in the same boot", async () => {
    const harness = makeHarness("input_pending");

    await afterRunnerRecovery(harness.startup);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);

    expect(harness.state()).toBe("pending");
    expect(harness.claimQueuedAfterNodeRestart).toHaveBeenCalledOnce();
    expect(harness.inspect).toHaveBeenCalledOnce();
    expect(harness.retryDeliveryAttempt).toHaveBeenCalledOnce();
    expect(harness.retryDeliveryAttempt).toHaveBeenCalledWith(
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

    await afterRunnerRecovery(harness.startup);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);

    expect(harness.state()).toBe("consumed");
    expect(harness.claimQueuedAfterNodeRestart).toHaveBeenCalledOnce();
    expect(harness.inspect).toHaveBeenCalledOnce();
    expect(harness.markConsumed).toHaveBeenCalledOnce();
    expect(harness.retryDeliveryAttempt).not.toHaveBeenCalled();
    await harness.startup.stop();
  });

  it("does not replay a live-consumed delivery when restart lands before turn terminal", async () => {
    const deliveryId = "delivery-live-consumed";
    let state: "queued" | "claimed" | "consumed" = "queued";
    let targetReceiptId: string | null = null;
    const row = (): SessionDeliveryRow => ({
      delivery_id: deliveryId,
      state,
      aggregate_state: state === "consumed" ? "consumed" : "pending",
      attempt_token: state === "claimed" ? "startup-worker" : null,
      target_receipt_id: targetReceiptId,
    }) as SessionDeliveryRow;
    const message: InterventionMessage = {
      text: "live steer already seen by the agent",
      user: "director",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:sess-live:${deliveryId}`,
    };
    const task: Task = {
      agentSessionId: "sess-live",
      prompt: "active turn",
      status: "running",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      lastEventId: 8250,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const recordConsumed = vi.fn(async (
      _message: InterventionMessage,
      _task: Task,
      consumedTurnId?: string,
    ) => {
      state = "consumed";
      targetReceiptId = consumedTurnId ?? null;
    });
    const receipt = new TaskDeliveryTurnReceipt(
      new TaskDeliveryConsumption({
        recordTurnStarted: vi.fn(async () => undefined),
        recordConsumed,
        discardIfConsumed: vi.fn(async () => false),
      }, { warn: vi.fn() } as unknown as Logger),
      [],
    );

    await receipt.observe(task, {
      type: "assistant_message",
      content: "turn is active",
    } as SSEEventPayload);
    await receipt.register(message);

    const claimQueuedAfterNodeRestart = vi.fn(async () => {
      if (state !== "queued") return [];
      state = "claimed";
      return [row()];
    });
    const inspect = vi.fn(async () => ({
      kind: "absent" as const,
      inputUuid: buildDeliveryInputUuid(deliveryId),
    }));
    const redeliverContent = vi.fn(async () => undefined);
    const recovery = new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: {
        get: vi.fn(async () => row()),
        markConsumed: vi.fn(),
        retryDeliveryAttempt: vi.fn(),
      },
      recoveryRepository: {
        claimQueuedAfterNodeRestart,
        markDeliveredFromTranscript: vi.fn(),
      },
      transcriptReceipt: { inspect },
      redeliverContent,
      logger: { warn: vi.fn() },
    }, "startup-worker");

    await expect(recovery.recoverAfterNodeRestart("node-a")).resolves.toEqual({
      claimed: 0,
      settled: 0,
    });
    expect(state).toBe("consumed");
    expect(targetReceiptId).toBe("event:8250");
    expect(recordConsumed).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
    expect(redeliverContent).not.toHaveBeenCalled();

    await receipt.consume(task);
    expect(recordConsumed).toHaveBeenCalledOnce();
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
    attempt_token: state === "claimed" ? "startup-worker" : null,
    target_receipt_id: receiptId,
  }) as SessionDeliveryRow;
  const claimQueuedAfterNodeRestart = vi.fn(async () => {
    if (state !== "queued") return [];
    state = "claimed";
    return [row()];
  });
  const retryDeliveryAttempt = vi.fn(async () => {
    if (state !== "claimed") return null;
    state = "pending";
    return row();
  });
  const markDeliveredFromTranscript = vi.fn(async (
    _deliveryId: string,
    _attemptToken: string,
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
      retryDeliveryAttempt,
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
    retryDeliveryAttempt,
  };
}

async function afterRunnerRecovery(
  startup: ClaudeRuntimeStartupRecovery,
): Promise<void> {
  await startup.afterRunnerRecovery();
}
