import { describe, expect, it, vi } from "vitest";

import { CompletionDeliveryRecoveryWorker } from "../../src/task/completion_delivery_recovery_worker.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("CompletionDeliveryRecoveryWorker", () => {
  it("continues retrying after repeated failures without an attempt cap", async () => {
    const recoverPending = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure 1"))
      .mockRejectedValueOnce(new Error("temporary failure 2"))
      .mockResolvedValue(undefined);
    const recoverNotifications = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const worker = new CompletionDeliveryRecoveryWorker(
      { recoverPending, recoverNotifications, logger },
      10,
    );

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    expect(recoverPending).toHaveBeenCalledTimes(3);
    expect(recoverNotifications).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  /**
   * 260820 incident: recoverPending never settled, so the re-entrancy gate was
   * never cleared and every later tick returned silently. The lane went dead
   * with zero log lines for three hours.
   */
  it("keeps ticking when a recovery step never settles", async () => {
    const recoverPending = vi.fn(() => new Promise<void>(() => {}));
    const recoverNotifications = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const worker = new CompletionDeliveryRecoveryWorker(
      { recoverPending, recoverNotifications, logger },
      10,
      20,
    );

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    // The notification lane must survive a wedged delivery lane.
    expect(recoverNotifications).toHaveBeenCalledTimes(3);
    // The wedged step is started once, never re-entered while outstanding.
    expect(recoverPending).toHaveBeenCalledTimes(1);
    // The stall is loud.
    const errors = logger.error.mock.calls;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(([, message]) =>
      String(message).includes("exceeded its deadline")
    )).toBe(true);
    expect(errors.some(([context]) =>
      (context as { step?: string }).step === "recover_pending_deliveries"
    )).toBe(true);
  });

  it("suppresses an overlapping scan while the active tick is healthy", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recoverPending = vi.fn(() => blocked);
    const recoverNotifications = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const worker = new CompletionDeliveryRecoveryWorker(
      { recoverPending, recoverNotifications, logger },
      10,
      10_000,
    );

    const first = worker.runOnce();
    await worker.runOnce();
    expect(recoverPending).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    release();
    await first;
    await worker.runOnce();
    expect(recoverPending).toHaveBeenCalledTimes(2);
    expect(recoverNotifications).toHaveBeenCalledTimes(2);
  });

  it("awaits the active recovery tick during graceful shutdown", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recoverPending = vi.fn(() => blocked);
    const recoverNotifications = vi.fn().mockResolvedValue(undefined);
    const worker = new CompletionDeliveryRecoveryWorker(
      { recoverPending, recoverNotifications, logger: makeLogger() },
      10,
      10_000,
    );

    const tick = worker.runOnce();
    const stopping = worker.stop(1_000);
    release();

    await expect(stopping).resolves.toBe("drained");
    await tick;
    expect(recoverNotifications).not.toHaveBeenCalled();
  });
});
