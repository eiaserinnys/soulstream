import { describe, expect, it, vi } from "vitest";

import { ExecutionOwnershipBackoff } from
  "../../src/task/execution_ownership_backoff.js";

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("ExecutionOwnershipBackoff", () => {
  /**
   * 260820 incident: the scan ran on its own 14s interval and ignored the
   * +60s retryAt the ownership rejection returned, retrying roughly four
   * times faster than the contract allowed.
   */
  it("holds a session until the retryAt the ownership rejection asked for", () => {
    let nowMs = 1_000_000;
    const backoff = new ExecutionOwnershipBackoff({
      logger: makeLogger(),
      now: () => nowMs,
    });

    expect(backoff.shouldSkip("session-a")).toBe(false);
    backoff.observeConflict("session-a", new Date(nowMs + 60_000).toISOString());

    // A scan 14s later — the old cadence — must not retry.
    nowMs += 14_000;
    expect(backoff.shouldSkip("session-a")).toBe(true);
    nowMs += 14_000;
    expect(backoff.shouldSkip("session-a")).toBe(true);

    nowMs += 40_000;
    expect(backoff.shouldSkip("session-a")).toBe(false);
  });

  it("drops a session from the scan once conflicts stop clearing, and says so once", () => {
    let nowMs = 0;
    const logger = makeLogger();
    const backoff = new ExecutionOwnershipBackoff({
      logger,
      now: () => nowMs,
      maxConsecutiveConflicts: 3,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      backoff.observeConflict("session-a", new Date(nowMs).toISOString());
    }

    // Excluded even though every retryAt has already elapsed.
    nowMs += 10 * 60_000;
    expect(backoff.shouldSkip("session-a")).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);

    backoff.observeConflict("session-a", new Date(nowMs).toISOString());
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("forgets a session as soon as recovery succeeds", () => {
    const backoff = new ExecutionOwnershipBackoff({
      logger: makeLogger(),
      now: () => 0,
    });

    backoff.observeConflict("session-a", new Date(60_000).toISOString());
    expect(backoff.shouldSkip("session-a")).toBe(true);

    backoff.clear("session-a");
    expect(backoff.shouldSkip("session-a")).toBe(false);
  });

  it("counts conflicts per session", () => {
    const logger = makeLogger();
    const backoff = new ExecutionOwnershipBackoff({
      logger,
      now: () => 0,
      maxConsecutiveConflicts: 2,
    });

    backoff.observeConflict("session-a", new Date(0).toISOString());
    backoff.observeConflict("session-b", new Date(0).toISOString());

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("drops state for registrations that no longer exist", () => {
    const backoff = new ExecutionOwnershipBackoff({
      logger: makeLogger(),
      now: () => 0,
    });

    backoff.observeConflict("session-a", new Date(60_000).toISOString());
    backoff.prune(["session-b"]);

    expect(backoff.shouldSkip("session-a")).toBe(false);
  });

  it("retries immediately when the rejection reports an unusable retryAt", () => {
    const backoff = new ExecutionOwnershipBackoff({
      logger: makeLogger(),
      now: () => 5_000,
    });

    backoff.observeConflict("session-a", "not-a-timestamp");

    expect(backoff.shouldSkip("session-a")).toBe(false);
  });
});
