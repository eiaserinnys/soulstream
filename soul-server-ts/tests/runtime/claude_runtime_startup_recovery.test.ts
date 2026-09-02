import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { ClaudeRuntimeStartupRecovery } from
  "../../src/runtime/claude_runtime_startup_recovery.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeRuntimeStartupRecovery", () => {
  it("keeps startup non-fatal without retrying either failed boot step", async () => {
    const recoverQueuedDeliveries = vi.fn()
      .mockRejectedValue(new Error("orchestrator unavailable"));
    const recoverBackgroundTasks = vi.fn()
      .mockRejectedValue(new Error("still unavailable"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const recovery = new ClaudeRuntimeStartupRecovery({
      recoverQueuedDeliveries,
      recoverBackgroundTasks,
      logger,
      nodeId: "windows-node",
    });

    await expect(recovery.start()).resolves.toBeUndefined();
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(1);
    expect(recoverQueuedDeliveries).not.toHaveBeenCalled();

    await expect(recovery.afterRunnerRecovery()).resolves.toBeUndefined();
    await expect(recovery.afterRunnerRecovery()).resolves.toBeUndefined();
    expect(recoverQueuedDeliveries).toHaveBeenCalledOnce();
    expect(recoverBackgroundTasks).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("waits for runner convergence before taking its one queued snapshot", async () => {
    const recoverQueuedDeliveries = vi.fn().mockResolvedValue({
      claimed: 0,
      settled: 0,
    });
    const recoverBackgroundTasks = vi.fn().mockResolvedValue(0);
    const recovery = new ClaudeRuntimeStartupRecovery({
      recoverQueuedDeliveries,
      recoverBackgroundTasks,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nodeId: "windows-node",
    });

    await recovery.start();
    expect(recoverQueuedDeliveries).not.toHaveBeenCalled();
    await recovery.afterRunnerRecovery();
    await recovery.afterRunnerRecovery();
    expect(recoverQueuedDeliveries).toHaveBeenCalledOnce();
    expect(recoverBackgroundTasks).toHaveBeenCalledOnce();
  });

  it("returns input-pending content without selecting it again in the same boot", async () => {
    const claimedRow = {
      delivery_id: "delivery-restart-ack-gap",
      state: "claimed",
      attempt_token: "startup-worker",
    } as SessionDeliveryRow;
    const inspect = vi.fn().mockResolvedValue({
      kind: "input_pending" as const,
      inputUuid: "delivery:delivery-restart-ack-gap",
    });
    const markConsumed = vi.fn(async () => ({
      ...claimedRow,
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: "transcript:assistant-after-restart",
    }) as SessionDeliveryRow);
    const queuedRecovery = new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: {
        get: vi.fn(async () => claimedRow),
        markConsumed,
        retryDeliveryAttempt: vi.fn(async () => null),
      },
      recoveryRepository: {
        claimQueuedAfterNodeRestart: vi.fn(async () => [claimedRow]),
        markDeliveredFromTranscript: vi.fn(async () => claimedRow),
        deferQueuedTranscriptCheck: vi.fn(async () => claimedRow),
      },
      transcriptReceipt: { inspect },
      logger: { warn: vi.fn() },
    } as never, "startup-worker");
    const recovery = new ClaudeRuntimeStartupRecovery(
      {
        recoverQueuedDeliveries: () =>
          queuedRecovery.recoverAfterNodeRestart("node-a"),
        recoverBackgroundTasks: vi.fn(async () => 0),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nodeId: "node-a",
      },
    );

    await recovery.start();
    await recovery.afterRunnerRecovery();
    await recovery.afterRunnerRecovery();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(markConsumed).not.toHaveBeenCalled();
    await recovery.stop();
  });

  it("drains an active recovery attempt during graceful shutdown", async () => {
    let release!: () => void;
    const blocked = new Promise<{ claimed: number; settled: number }>((resolve) => {
      release = () => resolve({ claimed: 0, settled: 0 });
    });
    const recoverQueuedDeliveries = vi.fn(() => blocked);
    const recoverBackgroundTasks = vi.fn().mockResolvedValue(0);
    const recovery = new ClaudeRuntimeStartupRecovery({
      recoverQueuedDeliveries,
      recoverBackgroundTasks,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nodeId: "windows-node",
    });

    await recovery.start();
    const recovering = recovery.afterRunnerRecovery();
    const stopping = recovery.stop(1_000);
    release();

    await expect(stopping).resolves.toBe("drained");
    await recovering;
    expect(recoverBackgroundTasks).toHaveBeenCalledOnce();
  });
});
