import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SHUTDOWN_DEADLINE_MS,
  armShutdownDeadline,
} from "../src/production_main.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("orchestrator shutdown deadline", () => {
  it("logs the stuck stage and exits 1 when shutdown passes the deadline", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const error = vi.fn();
    let stage = "app_close";
    const clear = armShutdownDeadline({
      currentStage: () => stage,
      logger: { error },
      exit,
    });
    try {
      vi.advanceTimersByTime(SHUTDOWN_DEADLINE_MS - 1);
      expect(exit).not.toHaveBeenCalled();

      stage = "card_dispatch_drain";
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith(
        "orchestrator shutdown deadline exceeded; exiting",
        expect.objectContaining({
          event: "orchestrator.shutdown_deadline",
          stage: "card_dispatch_drain",
          deadline_ms: SHUTDOWN_DEADLINE_MS,
        }),
      );
    } finally {
      clear();
    }
  });

  it("does not fire after a shutdown that finishes in time", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const clear = armShutdownDeadline({
      currentStage: () => "resources_close",
      logger: { error: vi.fn() },
      exit,
    });
    clear();
    vi.advanceTimersByTime(SHUTDOWN_DEADLINE_MS * 2);
    expect(exit).not.toHaveBeenCalled();
  });
});
