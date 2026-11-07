import { describe, expect, it } from "vitest";

import {
  estimateClaudeTextTokens,
  estimateClaudeTurnInputTokens,
  shouldPreemptivelyCompact,
} from "../../src/task/claude_context_recovery.js";

describe("Claude context token estimation", () => {
  it("uses capped and cold-cache thresholds while retaining the 200K threshold", () => {
    expect(shouldPreemptivelyCompact({ usedTokens: 275_000, maxTokens: 1_000_000 }, 10_000)).toBe(true);
    expect(shouldPreemptivelyCompact({ usedTokens: 250_000, maxTokens: 1_000_000 }, 10_000)).toBe(false);
    expect(shouldPreemptivelyCompact({ usedTokens: 159_999, maxTokens: 200_000 }, 10_000)).toBe(false);
    expect(shouldPreemptivelyCompact({ usedTokens: 160_000, maxTokens: 200_000 }, 10_000)).toBe(true);
    expect(shouldPreemptivelyCompact({ usedTokens: 155_000, maxTokens: 1_000_000 }, 10_000, { idleMs: 55 * 60_000 })).toBe(true);
    expect(shouldPreemptivelyCompact({ usedTokens: 155_000, maxTokens: 1_000_000, observedAtMs: 1_000 }, 10_000, { nowMs: 3_601_000 })).toBe(true);
  });
  it("applies class-aware conservative estimates with one shared safety margin", () => {
    expect(estimateClaudeTextTokens("a".repeat(35))).toBe(13);
    expect(estimateClaudeTextTokens("한".repeat(10))).toBe(13);
    expect(estimateClaudeTextTokens("漢かなカナ".repeat(10))).toBe(63);
    expect(estimateClaudeTextTokens("🙂".repeat(10))).toBe(13);
    expect(estimateClaudeTurnInputTokens({
      prompt: "a".repeat(35),
      systemPrompt: "한".repeat(10),
    })).toBe(25);
  });

  it("does not underestimate a tens-of-KB Korean workload at the 1 char/token bound", () => {
    const koreanPrompt = "한".repeat(40_000);

    const estimatedTokens = estimateClaudeTextTokens(koreanPrompt);

    expect(Buffer.byteLength(koreanPrompt, "utf8")).toBe(120_000);
    expect(estimatedTokens).toBe(50_000);
    expect(estimatedTokens).toBeGreaterThanOrEqual(koreanPrompt.length);
  });

  it.each([
    { maxTokens: 200_000, usedTokens: 160_000, incomingCjkChars: 8_000 },
    { maxTokens: 1_000_000, usedTokens: 840_000, incomingCjkChars: 8_000 },
  ])(
    "triggers the $maxTokens model threshold for a large Korean turn jump",
    ({ maxTokens, usedTokens, incomingCjkChars }) => {
      const incomingTokens = estimateClaudeTurnInputTokens({
        prompt: "한".repeat(incomingCjkChars),
      });

      expect(incomingTokens).toBe(10_000);
      expect(shouldPreemptivelyCompact(
        { usedTokens, maxTokens },
        incomingTokens,
      )).toBe(true);
    },
  );
});
