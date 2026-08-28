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
  it("keeps startup non-fatal and retries each failed recovery independently", async () => {
    vi.useFakeTimers();
    const recoverQueuedDeliveries = vi.fn()
      .mockRejectedValueOnce(new Error("orchestrator unavailable"))
      .mockResolvedValueOnce({ claimed: 2, settled: 2 })
      .mockResolvedValue({ claimed: 0, settled: 0 });
    const recoverBackgroundTasks = vi.fn()
      .mockRejectedValueOnce(new Error("orchestrator unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValue(1);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const recovery = new ClaudeRuntimeStartupRecovery(
      {
        recoverQueuedDeliveries,
        recoverBackgroundTasks,
        logger,
        nodeId: "windows-node",
      },
      50,
    );

    await expect(recovery.start()).resolves.toBeUndefined();
    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(1);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(2);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(50);
    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(3);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      { count: 2, nodeId: "windows-node" },
      "Reconciled queued deliveries after worker restart",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { count: 1, nodeId: "windows-node" },
      "Recovered in-flight Claude background tasks after worker restart",
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(3);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(3);
  });

  it("does not retry a successful step while another step remains unavailable", async () => {
    vi.useFakeTimers();
    const recoverQueuedDeliveries = vi.fn().mockResolvedValue({
      claimed: 0,
      settled: 0,
    });
    const recoverBackgroundTasks = vi.fn()
      .mockRejectedValueOnce(new Error("orchestrator unavailable"))
      .mockResolvedValue(0);
    const recovery = new ClaudeRuntimeStartupRecovery(
      {
        recoverQueuedDeliveries,
        recoverBackgroundTasks,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nodeId: "windows-node",
      },
      50,
    );

    await recovery.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(1);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(2);
  });

  it("rechecks an input-pending delivery until its completed transcript is consumed", async () => {
    vi.useFakeTimers();
    const claimedRow = {
      delivery_id: "delivery-restart-ack-gap",
      state: "claimed",
      lease_owner: "startup-worker",
    } as SessionDeliveryRow;
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        kind: "input_pending" as const,
        inputUuid: "delivery:delivery-restart-ack-gap",
      })
      .mockResolvedValueOnce({
        kind: "completed" as const,
        inputUuid: "delivery:delivery-restart-ack-gap",
        assistantMessageUuid: "assistant-after-restart",
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
        retryLeasedDelivery: vi.fn(async () => null),
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
      50,
    );

    await recovery.start();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(markConsumed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(markConsumed).toHaveBeenCalledOnce();
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

    const starting = recovery.start();
    const stopping = recovery.stop(1_000);
    release();

    await expect(stopping).resolves.toBe("drained");
    await starting;
    expect(recoverBackgroundTasks).not.toHaveBeenCalled();
  });
});
