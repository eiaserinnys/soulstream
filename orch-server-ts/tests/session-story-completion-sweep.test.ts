import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { SessionStoryCompletionSweep } from
  "../src/turn-summary/session_story_completion_sweep.js";
import { TurnSummaryConfigService, type TurnSummaryConfig } from
  "../src/turn-summary/turn_summary_config.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";
import { summarySettingsReader } from "./helpers/summary_settings.js";

const CONFIG = {
  turnEnabled: true,
  sessionEnabled: true,
  storyCompletionGraceMs: 1_800_000,
  storyCompletionMinSummaries: 5,
  storyCompletionSweepIntervalMs: 60_000,
} as TurnSummaryConfig;

describe("SessionStoryCompletionSweep", () => {
  it("starts with a legacy openai-api model overlay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "story-sweep-api-legacy-"));
    try {
      const path = join(dir, "turn-summary.yaml");
      const source = readFileSync(fileURLToPath(new URL("../config/turn-summary.yaml", import.meta.url)), "utf8");
      writeFileSync(path, source, "utf8");
      writeFileSync(join(dir, "turn-summary.local.yaml"), "provider: openai-api\nmodel: summary-model\n", "utf8");
      const sweep = new SessionStoryCompletionSweep({
        repository: { listCompletedFoldCandidates: vi.fn() },
        folder: { foldCompletedIfNeeded: vi.fn() },
        configService: new TurnSummaryConfigService(path, { warn: vi.fn() }, repositoryModelCatalog(), summarySettingsReader()),
        logger: { warn: vi.fn() },
      });

      expect(() => sweep.start()).not.toThrow();
      sweep.stop();
      await sweep.drain();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("runs no round while session summaries are off, and still runs with turn summaries off", async () => {
    const listCompletedFoldCandidates = vi.fn().mockResolvedValue([]);
    const read = vi.fn(() => ({ ...CONFIG, turnEnabled: true, sessionEnabled: false }));
    const sweep = new SessionStoryCompletionSweep({
      repository: { listCompletedFoldCandidates },
      folder: { foldCompletedIfNeeded: vi.fn() },
      configService: { read },
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    await sweep.sweep();
    expect(listCompletedFoldCandidates).not.toHaveBeenCalled();

    read.mockReturnValue({ ...CONFIG, turnEnabled: false, sessionEnabled: true });
    await sweep.sweep();
    expect(listCompletedFoldCandidates).toHaveBeenCalledTimes(1);
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
