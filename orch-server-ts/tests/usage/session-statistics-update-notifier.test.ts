import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_STATISTICS_UPDATE_INTERVAL_MS,
  SessionStatisticsUpdateNotifier,
} from "../../src/usage/session_statistics_update_notifier.js";

describe("session statistics update notifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies at most once per five seconds however many facts land", () => {
    const notifier = new SessionStatisticsUpdateNotifier();
    const listener = vi.fn();
    notifier.subscribe(listener);

    for (let write = 0; write < 10; write += 1) {
      notifier.notify();
      vi.advanceTimersByTime(200);
    }

    expect(SESSION_STATISTICS_UPDATE_INTERVAL_MS).toBe(5_000);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    expect(listener).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  it("delivers the trailing change within one interval of the last write", () => {
    const notifier = new SessionStatisticsUpdateNotifier();
    const listener = vi.fn();
    notifier.subscribe(listener);

    notifier.notify();
    vi.advanceTimersByTime(4_000);
    notifier.notify();
    vi.advanceTimersByTime(900);
    notifier.notify();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4_999);
    expect(listener).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  it("notifies immediately when the previous notification is older than the interval", () => {
    const notifier = new SessionStatisticsUpdateNotifier();
    const listener = vi.fn();
    notifier.subscribe(listener);

    notifier.notify();
    vi.advanceTimersByTime(SESSION_STATISTICS_UPDATE_INTERVAL_MS);
    notifier.notify();

    expect(listener).toHaveBeenCalledTimes(2);
    notifier.stop();
  });
});
