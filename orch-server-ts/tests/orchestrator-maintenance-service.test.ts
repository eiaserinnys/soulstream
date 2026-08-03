import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORCHESTRATOR_MEMORY_LOG_INTERVAL_MS,
  ORCHESTRATOR_MEMORY_RSS_WARN_BYTES,
  ORCHESTRATOR_MAINTENANCE_INTERVAL_MS,
  OrchestratorMaintenanceService,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OrchestratorMaintenanceService", () => {
  it("owns one idempotent 60 second sweep timer and stops it", () => {
    vi.useFakeTimers();
    const sessionCache = {
      sweepExpired: vi.fn(() => ({
        terminalSessions: 1,
        disconnectedSessions: 2,
        total: 3,
      })),
    };
    const pushNotifier = {
      sweepExpired: vi.fn(() => ({
        toolInputs: 5,
        total: 5,
      })),
    };
    const service = new OrchestratorMaintenanceService({
      sessionCache,
      pushNotifier,
    });

    service.start();
    service.start();
    expect(sessionCache.sweepExpired).toHaveBeenCalledTimes(1);
    expect(pushNotifier.sweepExpired).toHaveBeenCalledTimes(1);
    expect(service.getLastSweepStats()).toMatchObject({
      sessionCacheEntries: 3,
      pushNotifierEntries: 5,
    });

    vi.advanceTimersByTime(ORCHESTRATOR_MAINTENANCE_INTERVAL_MS);
    expect(sessionCache.sweepExpired).toHaveBeenCalledTimes(2);
    expect(pushNotifier.sweepExpired).toHaveBeenCalledTimes(2);

    service.stop();
    vi.advanceTimersByTime(ORCHESTRATOR_MAINTENANCE_INTERVAL_MS);
    expect(sessionCache.sweepExpired).toHaveBeenCalledTimes(2);
    expect(pushNotifier.sweepExpired).toHaveBeenCalledTimes(2);
  });

  it("logs entry counts every five minutes and warns above 800 MiB without full collection", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let rss = ORCHESTRATOR_MEMORY_RSS_WARN_BYTES - 1;
    const summary = vi.fn(() => ({
      measuredAt: "2026-07-27T08:00:00.000Z",
      rss,
      heapUsed: 300,
      heapSizeLimit: 1_000,
      components: {
        session_replay_ring: 7,
        session_cache: 11,
      },
    }));
    const collect = vi.fn();
    const onInfo = vi.fn();
    const onWarning = vi.fn();
    const service = new OrchestratorMaintenanceService({
      sessionCache: {
        sweepExpired: () => ({
          terminalSessions: 0,
          disconnectedSessions: 0,
          total: 0,
        }),
      },
      pushNotifier: {
        sweepExpired: () => ({
          toolInputs: 0,
          total: 0,
        }),
      },
      memoryStats: { summary, collect },
      nowMs: () => nowMs,
      onInfo,
      onWarning,
    });

    service.start();
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onWarning).not.toHaveBeenCalled();

    nowMs = ORCHESTRATOR_MEMORY_LOG_INTERVAL_MS - 1;
    vi.advanceTimersByTime(4 * ORCHESTRATOR_MAINTENANCE_INTERVAL_MS);
    expect(onInfo).toHaveBeenCalledTimes(1);

    rss = ORCHESTRATOR_MEMORY_RSS_WARN_BYTES + 1;
    nowMs = ORCHESTRATOR_MEMORY_LOG_INTERVAL_MS;
    vi.advanceTimersByTime(ORCHESTRATOR_MAINTENANCE_INTERVAL_MS);
    expect(onInfo).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
      memory: expect.objectContaining({
        rss: ORCHESTRATOR_MEMORY_RSS_WARN_BYTES + 1,
        components: {
          session_replay_ring: 7,
          session_cache: 11,
        },
      }),
    }));
    expect(collect).not.toHaveBeenCalled();
    service.stop();
  });
});
