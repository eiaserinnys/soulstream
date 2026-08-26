import { describe, expect, it, vi } from "vitest";

import { startWorkerRuntime } from "../../src/runtime/worker_startup.js";

describe("worker startup ordering", () => {
  it("reaches listen and starts the upstream adapter before an owner-null recovery scan waits for application", async () => {
    const order: string[] = [];
    const info = vi.fn();
    const onRunnerRecoveryFailure = vi.fn();
    let finishRecovery!: () => void;
    const waitForApplication = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const ownerNullRunningSession = {
      sessionId: "owner-null-running",
      status: "running",
      executionOwner: null,
    } as const;
    const upstreamAdapter = {
      run: vi.fn(async () => {
        order.push("adapter");
        await new Promise<void>(() => {});
      }),
    };
    const runnerRecoveryCoordinator = {
      start: vi.fn(async () => {
        expect(ownerNullRunningSession).toMatchObject({
          status: "running",
          executionOwner: null,
        });
        order.push("scan");
        await waitForApplication;
      }),
    };
    const runtime = {
      createUpstreamAdapter: () => upstreamAdapter,
      runnerRecoveryCoordinator,
      completionDeliveryRecoveryWorker: { start: vi.fn() },
    };

    const started = await Promise.race([
      startWorkerRuntime({
        compose: async () => {
          order.push("compose");
          return runtime;
        },
        listen: async () => {
          order.push("listen");
        },
        logger: { info },
        onUpstreamFailure: vi.fn(),
        onRunnerRecoveryFailure,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("readiness deadline exceeded")), 50);
      }),
    ]);

    expect(started).toEqual({ runtime, upstreamAdapter });
    expect(order).toEqual(["compose", "listen", "adapter", "scan"]);
    expect(runnerRecoveryCoordinator.start).toHaveBeenCalledOnce();
    expect(runtime.completionDeliveryRecoveryWorker.start).not.toHaveBeenCalled();
    expect(info.mock.calls.map(([message]) => message)).toEqual([
      "Worker runtime composition starting",
      "Worker runtime composition completed",
      "Worker listeners ready",
      "Upstream adapter startup initiated",
      "Runner recovery initial scan starting after listeners and upstream adapter startup",
    ]);
    expect(onRunnerRecoveryFailure).not.toHaveBeenCalled();

    finishRecovery();
    await vi.waitFor(() => {
      expect(runtime.completionDeliveryRecoveryWorker.start).toHaveBeenCalledOnce();
    });
  });

  it("reports an initial recovery failure after readiness instead of hiding it", async () => {
    const recoveryError = new Error("scan failed");
    const onRunnerRecoveryFailure = vi.fn();
    const upstreamAdapter = {
      run: vi.fn(async () => await new Promise<void>(() => {})),
    };
    const runtime = {
      createUpstreamAdapter: () => upstreamAdapter,
      runnerRecoveryCoordinator: {
        start: vi.fn(async () => {
          throw recoveryError;
        }),
      },
    };

    await expect(startWorkerRuntime({
      compose: async () => runtime,
      listen: async () => {},
      logger: { info: vi.fn() },
      onUpstreamFailure: vi.fn(),
      onRunnerRecoveryFailure,
    })).resolves.toEqual({ runtime, upstreamAdapter });
    await vi.waitFor(() => {
      expect(onRunnerRecoveryFailure).toHaveBeenCalledWith(recoveryError);
    });
  });
});
