import { describe, expect, it, vi } from "vitest";

import { CompletionDeliveryRecoveryWorker } from "../../src/task/completion_delivery_recovery_worker.js";

describe("CompletionDeliveryRecoveryWorker", () => {
  it("continues retrying after repeated failures without an attempt cap", async () => {
    const recoverPending = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure 1"))
      .mockRejectedValueOnce(new Error("temporary failure 2"))
      .mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };
    const worker = new CompletionDeliveryRecoveryWorker(
      { recoverPending, logger },
      10,
    );

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    expect(recoverPending).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("does not overlap recovery scans", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recoverPending = vi.fn(() => blocked);
    const worker = new CompletionDeliveryRecoveryWorker(
      { recoverPending, logger: { warn: vi.fn() } },
      10,
    );

    const first = worker.runOnce();
    await worker.runOnce();
    expect(recoverPending).toHaveBeenCalledTimes(1);

    release();
    await first;
    await worker.runOnce();
    expect(recoverPending).toHaveBeenCalledTimes(2);
  });
});
