import { describe, expect, it, vi } from "vitest";

import { startWorkerRuntime } from "../../src/runtime/worker_startup.js";

describe("worker startup ordering", () => {
  it("reaches listen and starts the upstream adapter before an owner-null recovery scan waits for application", async () => {
    const order: string[] = [];
    const info = vi.fn();
    const onRunnerRecoveryFailure = vi.fn();
    const waitForApplication = new Promise<void>(() => {});
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
      upstreamRegistrationReady: Promise.resolve(),
      runnerRecoveryCoordinator,
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
    expect(info.mock.calls.map(([message]) => message)).toEqual([
      "Worker runtime composition starting",
      "Worker runtime composition completed",
      "Worker listeners ready",
      "Upstream adapter startup initiated",
      "Runner recovery initial scan starting after listeners and upstream adapter startup",
    ]);
    expect(onRunnerRecoveryFailure).not.toHaveBeenCalled();
  });

  it("reports an initial recovery failure after readiness instead of hiding it", async () => {
    const recoveryError = new Error("scan failed");
    const onRunnerRecoveryFailure = vi.fn();
    const upstreamAdapter = {
      run: vi.fn(async () => await new Promise<void>(() => {})),
    };
    const runtime = {
      createUpstreamAdapter: () => upstreamAdapter,
      upstreamRegistrationReady: Promise.resolve(),
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

  it("runs the one-shot transcript drain only after runner recovery converges", async () => {
    const order: string[] = [];
    let markUpstreamRegistered!: () => void;
    const upstreamRegistrationReady = new Promise<void>((resolve) => {
      markUpstreamRegistered = resolve;
    });
    const upstreamAdapter = {
      run: vi.fn(async () => await new Promise<void>(() => {})),
    };
    const runtime = {
      createUpstreamAdapter: () => upstreamAdapter,
      upstreamRegistrationReady,
      runnerRecoveryCoordinator: {
        start: vi.fn(async () => {
          order.push("runner_recovered");
        }),
      },
      claudeRuntimeStartupRecovery: {
        afterRunnerRecovery: vi.fn(async () => {
          order.push("transcript_drained");
        }),
      },
    };

    await startWorkerRuntime({
      compose: async () => runtime,
      listen: async () => {},
      logger: { info: vi.fn() },
      onUpstreamFailure: vi.fn(),
      onRunnerRecoveryFailure: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(order).toEqual(["runner_recovered"]);
    });
    expect(runtime.claudeRuntimeStartupRecovery.afterRunnerRecovery)
      .not.toHaveBeenCalled();

    markUpstreamRegistered();
    await vi.waitFor(() => {
      expect(order).toEqual(["runner_recovered", "transcript_drained"]);
    });
    expect(runtime.claudeRuntimeStartupRecovery.afterRunnerRecovery)
      .toHaveBeenCalledOnce();
  });
});
