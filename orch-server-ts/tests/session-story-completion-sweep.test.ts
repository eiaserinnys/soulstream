import { describe, expect, it, vi } from "vitest";

import { SessionStoryCompletionSweep } from
  "../src/turn-summary/session_story_completion_sweep.js";
import type { TurnSummaryConfig } from
  "../src/turn-summary/turn_summary_config.js";

const CONFIG = {
  enabled: true,
  storyCompletionGraceMs: 1_800_000,
  storyCompletionMinSummaries: 5,
  storyCompletionSweepIntervalMs: 60_000,
} as TurnSummaryConfig;

describe("SessionStoryCompletionSweep", () => {
  it("uses the exact 30 minute cutoff and finalizes every returned candidate", async () => {
    const candidate = {
      sessionId: "session-a",
      completedAt: new Date("2026-07-31T00:20:00.000Z"),
    };
    const listCompletedFoldCandidates = vi.fn().mockResolvedValue([candidate]);
    const foldCompletedIfNeeded = vi.fn().mockResolvedValue(undefined);
    const sweep = new SessionStoryCompletionSweep({
      repository: { listCompletedFoldCandidates },
      folder: { foldCompletedIfNeeded },
      configService: { read: () => CONFIG },
      logger: { warn: vi.fn(), debug: vi.fn() },
      nowMs: () => new Date("2026-07-31T01:00:00.000Z").getTime(),
    });

    await sweep.sweep();

    const cutoff = new Date("2026-07-31T00:30:00.000Z");
    expect(listCompletedFoldCandidates).toHaveBeenCalledWith({
      completedBefore: cutoff,
      minimumSummaryCount: 5,
      limit: 100,
    });
    expect(foldCompletedIfNeeded).toHaveBeenCalledWith(candidate, cutoff, 5);
  });

  it("coalesces overlapping sweeps into one candidate query", async () => {
    let release: (() => void) | undefined;
    const listCompletedFoldCandidates = vi.fn(async () =>
      await new Promise<[]>(resolve => {
        release = () => resolve([]);
      })
    );
    const sweep = new SessionStoryCompletionSweep({
      repository: { listCompletedFoldCandidates },
      folder: { foldCompletedIfNeeded: vi.fn() },
      configService: { read: () => CONFIG },
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    const first = sweep.sweep();
    const second = sweep.sweep();
    release?.();
    await Promise.all([first, second]);

    expect(listCompletedFoldCandidates).toHaveBeenCalledTimes(1);
  });
});
