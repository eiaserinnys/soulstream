import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnSummaryCatchUpSweep } from
  "../src/turn-summary/turn_summary_catch_up_sweep.js";
import type { TurnSummaryCatchUpCandidate } from
  "../src/turn-summary/turn_summary_catch_up_repository.js";
import type { TurnSummaryConfig } from
  "../src/turn-summary/turn_summary_config.js";
import type { TurnSummaryJobOutcome } from
  "../src/turn-summary/turn_summary_pipeline.js";

const NOW = new Date("2026-11-21T00:00:00.000Z").getTime();

const BASE_CONFIG = {
  turnEnabled: true,
  sessionEnabled: true,
  excludedFolderIds: ["055be5a6-1285-48aa-a8a1-59e40fbe59af"],
  catchUpIntervalMs: 900_000,
  catchUpWindowHours: 72,
  catchUpMaxJobsPerRound: 100,
} as TurnSummaryConfig;

const CANDIDATES: TurnSummaryCatchUpCandidate[] = [
  { nodeId: "node-a", sessionId: "session-a", completeEventId: 11 },
  { nodeId: "node-b", sessionId: "session-b", completeEventId: 12 },
];

afterEach(() => {
  vi.useRealTimers();
});

function createSweep(options: {
  candidates?: TurnSummaryCatchUpCandidate[];
  config?: TurnSummaryConfig;
  outcomes?: TurnSummaryJobOutcome[];
} = {}) {
  const listCatchUpCandidates = vi.fn().mockResolvedValue(
    options.candidates ?? [],
  );
  const enqueue = vi.fn();
  for (const outcome of options.outcomes ?? []) {
    enqueue.mockResolvedValueOnce(outcome);
  }
  const info = vi.fn();
  const warn = vi.fn();
  const config = options.config ?? BASE_CONFIG;
  const sweep = new TurnSummaryCatchUpSweep({
    repository: { listCatchUpCandidates },
    pipeline: { enqueue },
    configService: { read: () => config },
    logger: { debug: vi.fn(), info, warn },
    nowMs: () => NOW,
  });
  return { sweep, listCatchUpCandidates, enqueue, info, warn };
}

describe("TurnSummaryCatchUpSweep", () => {
  it("queries the window, enqueues candidates oldest first, and logs one info line", async () => {
    const { sweep, listCatchUpCandidates, enqueue, info } = createSweep({
      candidates: CANDIDATES,
      outcomes: [
        { status: "stored" },
        { status: "skipped", reason: "already_summarized" },
      ],
    });

    await sweep.sweep();

    expect(listCatchUpCandidates).toHaveBeenCalledWith({
      since: new Date(NOW - 72 * 3_600_000),
      olderThan: new Date(NOW - 10 * 60_000),
      excludedFolderIds: BASE_CONFIG.excludedFolderIds,
      excludedTurns: [],
      limit: 100,
    });
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual(CANDIDATES);
    expect(info).toHaveBeenCalledWith(
      {
        candidates: 2,
        enqueued: 2,
        stored: 1,
        skipped: 1,
        failed: 0,
        remembered: 0,
        stoppedByUsageLimit: false,
      },
      "Turn summary catch-up",
    );
  });

  it("stops the round after a Codex usage-limit failure", async () => {
    const usageLimit = Object.assign(
      new Error("codex exec exited 1: You've hit your usage limit."),
      { code: "CODEX_USAGE_LIMIT" },
    );
    const error = new Error("turn summary failed after 1 attempts", {
      cause: usageLimit,
    });
    const { sweep, enqueue, info, warn } = createSweep({
      candidates: CANDIDATES,
      outcomes: [{ status: "failed", error }],
    });

    await sweep.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        completeEventId: 11,
        limitMessage: expect.stringContaining("usage limit"),
      }),
      "Turn summary catch-up stopped: usage limit",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        enqueued: 1,
        failed: 0,
        stoppedByUsageLimit: true,
      }),
      "Turn summary catch-up",
    );
  });

  it("stops the round when the error chain holds only a Claude usage limit", async () => {
    const usageLimit = Object.assign(new Error("claude hit your usage limit"), { code: "CLAUDE_USAGE_LIMIT" });
    const error = new Error("turn summary failed after 1 attempts", { cause: usageLimit });
    const { sweep, enqueue, info } = createSweep({
      candidates: CANDIDATES,
      outcomes: [{ status: "failed", error }],
    });

    await sweep.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 0, stoppedByUsageLimit: true }),
      "Turn summary catch-up",
    );
  });

  it("continues after a non-usage-limit failure and remembers it", async () => {
    const { sweep, listCatchUpCandidates, enqueue, info } = createSweep({
      candidates: CANDIDATES,
      outcomes: [
        { status: "failed", error: new Error("statement timeout") },
        { status: "stored" },
      ],
    });
    listCatchUpCandidates
      .mockResolvedValueOnce(CANDIDATES)
      .mockResolvedValueOnce([]);

    await sweep.sweep();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        enqueued: 2,
        stored: 1,
        failed: 1,
        stoppedByUsageLimit: false,
      }),
      "Turn summary catch-up",
    );

    await sweep.sweep();

    expect(listCatchUpCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        excludedTurns: [{ sessionId: "session-a", completeEventId: 11 }],
      }),
    );
  });

  it("remembers non-error skips and leaves them out of the next round", async () => {
    const { sweep, listCatchUpCandidates, enqueue, info } = createSweep({
      candidates: [CANDIDATES[0]!],
      outcomes: [{ status: "skipped", reason: "turn_not_reconstructable" }],
    });

    await sweep.sweep();
    await sweep.sweep();

    expect(listCatchUpCandidates).toHaveBeenCalledTimes(2);
    expect(listCatchUpCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        excludedTurns: [{ sessionId: "session-a", completeEventId: 11 }],
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidates: 1,
        enqueued: 0,
        remembered: 1,
      }),
      "Turn summary catch-up",
    );
  });

  it("does not query while turn summaries are disabled", async () => {
    const { sweep, listCatchUpCandidates, info } = createSweep({
      candidates: CANDIDATES,
      config: { ...BASE_CONFIG, turnEnabled: false },
    });

    await sweep.sweep();

    expect(listCatchUpCandidates).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("runs the first round about a minute after start", async () => {
    vi.useFakeTimers();
    const { sweep, listCatchUpCandidates } = createSweep();

    sweep.start();
    expect(listCatchUpCandidates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(listCatchUpCandidates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listCatchUpCandidates).toHaveBeenCalledTimes(1);
    await sweep.drain();
    sweep.stop();
  });
});
