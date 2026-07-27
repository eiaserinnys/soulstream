import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
        lastStatuses: 4,
        toolInputs: 5,
        total: 9,
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
      pushNotifierEntries: 9,
    });

    vi.advanceTimersByTime(ORCHESTRATOR_MAINTENANCE_INTERVAL_MS);
    expect(sessionCache.sweepExpired).toHaveBeenCalledTimes(2);
    expect(pushNotifier.sweepExpired).toHaveBeenCalledTimes(2);

    service.stop();
    vi.advanceTimersByTime(ORCHESTRATOR_MAINTENANCE_INTERVAL_MS);
    expect(sessionCache.sweepExpired).toHaveBeenCalledTimes(2);
    expect(pushNotifier.sweepExpired).toHaveBeenCalledTimes(2);
  });
});
