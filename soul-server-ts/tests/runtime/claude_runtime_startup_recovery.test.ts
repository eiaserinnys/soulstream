import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeRuntimeStartupRecovery } from
  "../../src/runtime/claude_runtime_startup_recovery.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeRuntimeStartupRecovery", () => {
  it("keeps startup non-fatal and retries each failed recovery independently", async () => {
    vi.useFakeTimers();
    const recoverQueuedDeliveries = vi.fn()
      .mockRejectedValueOnce(new Error("orchestrator unavailable"))
      .mockResolvedValue(2);
    const recoverBackgroundTasks = vi.fn()
      .mockRejectedValueOnce(new Error("orchestrator unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValue(1);
    const logger = { warn: vi.fn() };
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
    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(2);
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
    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(2);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(3);
  });

  it("does not retry a successful step while another step remains unavailable", async () => {
    vi.useFakeTimers();
    const recoverQueuedDeliveries = vi.fn().mockResolvedValue(0);
    const recoverBackgroundTasks = vi.fn()
      .mockRejectedValueOnce(new Error("orchestrator unavailable"))
      .mockResolvedValue(0);
    const recovery = new ClaudeRuntimeStartupRecovery(
      {
        recoverQueuedDeliveries,
        recoverBackgroundTasks,
        logger: { warn: vi.fn() },
        nodeId: "windows-node",
      },
      50,
    );

    await recovery.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(recoverQueuedDeliveries).toHaveBeenCalledTimes(1);
    expect(recoverBackgroundTasks).toHaveBeenCalledTimes(2);
  });

  it("drains an active recovery attempt during graceful shutdown", async () => {
    let release!: () => void;
    const blocked = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const recoverQueuedDeliveries = vi.fn(() => blocked);
    const recoverBackgroundTasks = vi.fn().mockResolvedValue(0);
    const recovery = new ClaudeRuntimeStartupRecovery({
      recoverQueuedDeliveries,
      recoverBackgroundTasks,
      logger: { warn: vi.fn() },
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
