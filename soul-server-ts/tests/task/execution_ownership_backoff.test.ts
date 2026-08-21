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

  it("slows to a probe once conflicts stop clearing, and says so once", () => {
    let nowMs = 0;
    const logger = makeLogger();
    const backoff = new ExecutionOwnershipBackoff({
      logger,
      now: () => nowMs,
      maxConsecutiveConflicts: 3,
      stuckProbeIntervalMs: 5 * 60_000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      backoff.observeConflict("session-a", new Date(nowMs).toISOString());
    }

    // The rejection asked for "now", but a session this stuck is not retried
    // at scan cadence any more.
    nowMs += 60_000;
    expect(backoff.shouldSkip("session-a")).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);

    backoff.observeConflict("session-a", new Date(nowMs).toISOString());
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("does not count another caller while the shared retry deadline is still active", () => {
    let nowMs = 0;
    const logger = makeLogger();
    const backoff = new ExecutionOwnershipBackoff({
      logger,
      now: () => nowMs,
      maxConsecutiveConflicts: 2,
    });

    const retryAt = new Date(nowMs + 60_000).toISOString();
    backoff.observeConflict("session-a", retryAt);
    nowMs += 5_000;
    backoff.observeConflict("session-a", retryAt);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ consecutive: 1 }),
      expect.any(String),
    );
  });

  /**
   * The paths that can clear a wedge — dead-owner expiry, the owner finally
   * releasing, an operator — all run inside a recovery attempt. A session that
   * is never attempted again could never recover, so the probe must keep
   * coming back.
   */
  it("keeps probing a stuck session instead of stranding it", () => {
    let nowMs = 0;
    const backoff = new ExecutionOwnershipBackoff({
      logger: makeLogger(),
      now: () => nowMs,
      maxConsecutiveConflicts: 2,
      stuckProbeIntervalMs: 5 * 60_000,
    });

    backoff.observeConflict("session-a", new Date(nowMs).toISOString());
    backoff.observeConflict("session-a", new Date(nowMs).toISOString());
    expect(backoff.shouldSkip("session-a")).toBe(true);

    nowMs += 5 * 60_000;
    expect(backoff.shouldSkip("session-a")).toBe(false);
  });

  it("never shortens a backoff the rejection asked to be longer", () => {
    let nowMs = 0;
    const backoff = new ExecutionOwnershipBackoff({
      logger: makeLogger(),
      now: () => nowMs,
      maxConsecutiveConflicts: 1,
      stuckProbeIntervalMs: 60_000,
    });

    backoff.observeConflict("session-a", new Date(nowMs + 30 * 60_000).toISOString());

    nowMs += 10 * 60_000;
    expect(backoff.shouldSkip("session-a")).toBe(true);
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

  it("keeps the counter across paths even without a runner registration", () => {
    let nowMs = 0;
    const logger = makeLogger();
    const backoff = new ExecutionOwnershipBackoff({
      logger,
      now: () => nowMs,
      maxConsecutiveConflicts: 2,
    });

    backoff.observeConflict("session-a", new Date(60_000).toISOString());
    backoff.prune(["session-b"]);
    expect(backoff.shouldSkip("session-a")).toBe(true);

    nowMs = 60_000;
    backoff.prune(["session-b"]);
    expect(backoff.shouldSkip("session-a")).toBe(false);

    backoff.observeConflict("session-a", new Date(120_000).toISOString());
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a", consecutive: 2 }),
      expect.any(String),
    );
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
