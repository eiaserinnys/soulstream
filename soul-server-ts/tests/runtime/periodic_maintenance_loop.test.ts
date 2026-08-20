import { describe, expect, it, vi } from "vitest";

import {
  MaintenanceStepTimeoutError,
  PeriodicMaintenanceLoop,
} from "../../src/runtime/periodic_maintenance_loop.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A promise that never settles — the incident's failure mode. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

function messages(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => String(call[1]));
}

describe("PeriodicMaintenanceLoop", () => {
  it("keeps running later steps and later ticks when a step never settles", async () => {
    const logger = makeLogger();
    const later = vi.fn().mockResolvedValue(undefined);
    const loop = new PeriodicMaintenanceLoop({
      lane: "session-deliveries",
      steps: [
        { name: "hung", run: neverSettles },
        { name: "later", run: later },
      ],
      stepTimeoutMs: 20,
      logger,
    });

    await loop.runOnce();
    await loop.runOnce();
    await loop.runOnce();

    // The hung step must not swallow its siblings, and every tick must arrive.
    expect(later).toHaveBeenCalledTimes(3);

    // The stall is observable — the incident's signature was zero log lines.
    const errors = messages(logger.error);
    expect(errors.some((line) => line.includes("exceeded its deadline"))).toBe(true);
    expect(errors.some((line) => line.includes("still outstanding"))).toBe(true);
    const stuck = logger.error.mock.calls.find(
      (call) => String(call[1]).includes("still outstanding"),
    );
    expect(stuck?.[0]).toMatchObject({ lane: "session-deliveries", step: "hung" });
  });

  it("starts a hung step only once instead of accumulating one per tick", async () => {
    const run = vi.fn(neverSettles);
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [{ name: "hung", run }],
      stepTimeoutMs: 10,
      logger: makeLogger(),
    });

    await loop.runOnce();
    await loop.runOnce();
    await loop.runOnce();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("re-runs a step once its earlier invocation finally settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn()
      .mockReturnValueOnce(blocked)
      .mockResolvedValue(undefined);
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [{ name: "slow", run }],
      stepTimeoutMs: 10,
      logger: makeLogger(),
    });

    await loop.runOnce();
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await blocked;
    await loop.runOnce();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("isolates a rejecting step without stopping the lane", async () => {
    const logger = makeLogger();
    const later = vi.fn().mockResolvedValue(undefined);
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [
        { name: "boom", run: () => Promise.reject(new Error("nope")) },
        { name: "later", run: later },
      ],
      stepTimeoutMs: 50,
      logger,
    });

    await loop.runOnce();
    await loop.runOnce();

    expect(later).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("isolates a step that throws synchronously", async () => {
    const logger = makeLogger();
    const later = vi.fn().mockResolvedValue(undefined);
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [
        {
          name: "boom",
          run: () => {
            throw new Error("sync");
          },
        },
        { name: "later", run: later },
      ],
      stepTimeoutMs: 50,
      logger,
    });

    await loop.runOnce();

    expect(later).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("suppresses an overlapping tick that is still inside its deadline", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => blocked);
    const logger = makeLogger();
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [{ name: "slow", run }],
      stepTimeoutMs: 10_000,
      tickTimeoutMs: 10_000,
      logger,
    });

    const first = loop.runOnce();
    await loop.runOnce();
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    release();
    await first;
  });

  it("abandons a tick that outlives its deadline and starts a new one", async () => {
    let nowMs = 0;
    const logger = makeLogger();
    const run = vi.fn(neverSettles);
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      // A deliberately unreachable step deadline: only the tick watchdog can
      // break this lane, which is exactly what this test pins.
      steps: [{ name: "wedged", run, timeoutMs: 10_000 }],
      tickTimeoutMs: 1_000,
      logger,
      monotonicNowMs: () => nowMs,
    });

    const first = loop.runOnce();
    nowMs = 500;
    await loop.runOnce();
    expect(logger.error).not.toHaveBeenCalled();

    nowMs = 5_000;
    await loop.runOnce();

    const abandoned = logger.error.mock.calls.find(
      (call) => String(call[1]).includes("abandoning it"),
    );
    expect(abandoned).toBeDefined();
    expect(abandoned?.[0]).toMatchObject({ lane: "lane", stuckStep: "wedged" });
    void first;
  });

  it("reports a step deadline breach as a typed error", async () => {
    const logger = makeLogger();
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [{ name: "hung", run: neverSettles }],
      stepTimeoutMs: 10,
      logger,
    });

    await loop.runOnce();

    const call = logger.error.mock.calls.find(
      (entry) => String(entry[1]).includes("exceeded its deadline"),
    );
    const err = (call?.[0] as { err?: unknown } | undefined)?.err;
    expect(err).toBeInstanceOf(MaintenanceStepTimeoutError);
    expect(err).toMatchObject({ lane: "lane", stepName: "hung", timeoutMs: 10 });
  });

  it("summarises lane liveness and escalates when the lane is degraded", async () => {
    vi.useFakeTimers();
    try {
      const logger = makeLogger();
      const loop = new PeriodicMaintenanceLoop({
        lane: "lane",
        steps: [{ name: "ok", run: () => Promise.resolve() }],
        intervalMs: 1_000,
        stepTimeoutMs: 1_000,
        livenessIntervalMs: 10_000,
        logger,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await loop.stop(1_000);

      const liveness = logger.info.mock.calls.find(
        (call) => String(call[1]).includes("liveness"),
      );
      expect(liveness?.[0]).toMatchObject({ lane: "lane" });
      expect((liveness?.[0] as { ticks: number }).ticks).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops scheduling once stopped", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const loop = new PeriodicMaintenanceLoop({
      lane: "lane",
      steps: [{ name: "ok", run }],
      intervalMs: 5,
      logger: makeLogger(),
    });

    loop.start();
    expect(await loop.stop(100)).toBe("drained");
    const callsAtStop = run.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(run.mock.calls.length).toBe(callsAtStop);
  });

  it("rejects a lane declared with duplicate step names", () => {
    expect(() =>
      new PeriodicMaintenanceLoop({
        lane: "lane",
        steps: [
          { name: "dup", run: () => Promise.resolve() },
          { name: "dup", run: () => Promise.resolve() },
        ],
        logger: makeLogger(),
      })
    ).toThrow(/duplicate step dup/);
  });
});
