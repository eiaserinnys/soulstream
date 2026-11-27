import { describe, expect, it, vi } from "vitest";

import {
  markerOrderStats,
  SessionStoryFoldService,
  type SessionStoryGenerator,
} from "../src/turn-summary/session_story_fold_service.js";
import type { SessionStoryTurnSummary } from "@soulstream/mcp-contract";
import type {
  SessionStoryDigest,
  SessionStoryRepositoryPort,
} from "../src/turn-summary/session_story_repository.js";
import type { TurnSummaryConfig } from
  "../src/turn-summary/turn_summary_config.js";

const CONFIG: TurnSummaryConfig = {
  enabled: true,
  instruction: "턴을 요약하라.",
  storyInstruction: [
    "JSON 객체로 narrative와 highlight를 반환한다.",
    "줄거리의 모든 사건 문장에 [T12] 또는 [T12-T15] 턴 마커를 붙인다.",
    "결정이 번복된 경우 번복 이력을 시간 순서대로 남긴다.",
    "하이라이트는 5~6문장으로 작성한다.",
    "문장 수 유지를 위해 자를 때는 오래된 완료 로그부터 제거하되, 모델 선정·정책·보안 관련 결정은 연령과 무관하게 보존한다.",
  ].join("\n"),
  storyFoldThreshold: 10,
  storyFoldBatchSize: 5,
  storyFoldMaxBatchesPerRun: 4,
  storyCompletedFoldMaxSummaries: 40,
  storyCompletionGraceMs: 1_800_000,
  storyCompletionMinSummaries: 5,
  storyCompletionSweepIntervalMs: 60_000,
  storyNarrativeMaxChars: 1_500,
  storyTimeoutMs: 90_000,
  fallbackTimeoutMs: 90_000,
  storyFoldFailureCooldownMs: 900_000,
  catchUpIntervalMs: 900_000,
  catchUpWindowHours: 72,
  catchUpMaxJobsPerRound: 100,
  provider: "codex",
  model: "gpt-5.6-luna",
  storyModel: "gpt-5.6-terra",
  preferredStages: [],
  reasoningEffort: "high",
  instructionExtractionModel: "gpt-6.2-sol",
  instructionExtractionReasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
  codexConcurrencyLimit: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [],
};

describe("SessionStoryFoldService", () => {
  it.each(["batch", "completed_chunk", "completed"] as const)(
    "uses the story timeout, length instruction, and context in %s logs",
    async (kind) => {
      const summaries = bulkSummaries(kind === "completed_chunk" ? 41 : 5)
        .map((item, index) => index === 0 ? { ...item, content: `${item.content} 🧭` } : item);
      const repository = fakeRepository({ count: summaries.length, totalCount: summaries.length, summaries });
      if (kind === "batch") repository.countUnfoldedSummaries.mockReset().mockResolvedValue(10);
      if (kind === "completed_chunk") {
        repository.loadUnfoldedSummaries
          .mockResolvedValueOnce(summaries.slice(0, 40))
          .mockResolvedValueOnce(summaries.slice(40));
      }
      const generator = fakeGenerator({ narrative: "[T1] 접었다.", highlight: "완료." });
      const info = vi.fn();
      const service = new SessionStoryFoldService({
        repository, generator,
        configService: { read: () => ({ ...CONFIG, storyFoldMaxBatchesPerRun: 1 }) },
        logger: { debug: vi.fn(), info, warn: vi.fn() },
      });
      await runFold(service, kind);

      const [prompt, config] = generator.generate.mock.calls[0]!;
      expect(config.timeoutMs).toBe(90_000);
      expect(prompt).toContain(`${CONFIG.storyInstruction}\nnarrative는 공백 포함 1500자 이내로 쓴다. 넘칠 것 같으면 오래된 턴을 더 줄여 쓴다.\n\n[기존 줄거리]`);
      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        foldKind: kind, summaryCount: kind === "completed_chunk" ? 40 : 5,
        promptChars: Array.from(prompt).length, timeoutMs: 90_000,
      }), "Session story fold stored");
    },
  );

  it("stores a narrative longer than the advisory limit", async () => {
    const repository = fakeRepository({ count: 10 });
    const generator = fakeGenerator({ narrative: `[T1] ${"가".repeat(1501)}`, highlight: "완료." });
    const debug = vi.fn();
    const service = new SessionStoryFoldService({
      repository, generator, configService: { read: () => CONFIG },
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });
    await service.foldIfNeeded("session-a");
    expect(repository.storeDigest).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ narrativeMaxChars: 1500 }), "Session story output exceeds advisory shape");
  });

  it.each(["batch", "completed_chunk", "completed"] as const)(
    "logs two failed attempts and elapsed time for %s",
    async (kind) => {
      const summaries = bulkSummaries(kind === "completed_chunk" ? 41 : 5);
      const repository = fakeRepository({ count: summaries.length, totalCount: summaries.length, summaries });
      if (kind === "batch") repository.countUnfoldedSummaries.mockReset().mockResolvedValue(10);
      if (kind === "completed_chunk") repository.loadUnfoldedSummaries.mockResolvedValue(summaries.slice(0, 40));
      let now = 100;
      const generate = vi.fn().mockImplementation(async () => { now += 25; throw new Error("timeout"); });
      const warn = vi.fn();
      const service = new SessionStoryFoldService({
        repository, generator: { generate }, configService: { read: () => CONFIG },
        logger: { debug: vi.fn(), info: vi.fn(), warn }, nowMs: () => now,
      });
      await runFold(service, kind);
      const prompt = generate.mock.calls[0]![0] as string;
      expect(generate).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        foldKind: kind, summaryCount: kind === "completed_chunk" ? 40 : 5,
        promptChars: prompt.length, timeoutMs: 90_000, elapsedMs: 50,
      }), "Session story fold failed");
    },
  );

  it.each(["batch", "completed"] as const)(
    "shares the failure cooldown across both entry points after %s fails",
    async (firstKind) => {
      let now = 100;
      const repository = fakeRepository({ count: 5, totalCount: 5 });
      repository.countUnfoldedSummaries.mockReset().mockResolvedValue(10);
      const generate = vi.fn().mockRejectedValue(new Error("timeout"));
      const debug = vi.fn();
      const service = new SessionStoryFoldService({
        repository, generator: { generate },
        configService: { read: () => ({ ...CONFIG, storyFoldMaxBatchesPerRun: 1 }) },
        logger: { debug, info: vi.fn(), warn: vi.fn() }, nowMs: () => now,
      });
      await runFold(service, firstKind);
      expect(generate).toHaveBeenCalledTimes(2);
      await runFold(service, "batch");
      await runFold(service, "completed");
      expect(generate).toHaveBeenCalledTimes(2);
      expect(debug).toHaveBeenCalledWith(expect.objectContaining({ reason: "failure_cooldown" }), "Session story fold skipped");
      now += CONFIG.storyFoldFailureCooldownMs;
      generate.mockResolvedValue({ content: JSON.stringify({ narrative: "[T1] 복구.", highlight: "완료." }), model: "test", latencyMs: 1, attempts: 1 });
      await runFold(service, firstKind);
      await runFold(service, firstKind);
      expect(generate).toHaveBeenCalledTimes(4);
    },
  );

  it("cools down exceptions during a fold and does not affect other sessions", async () => {
    const repository = fakeRepository({ count: 10 });
    repository.countUnfoldedSummaries.mockReset().mockResolvedValue(10);
    repository.storeDigest.mockRejectedValueOnce(new Error("store unavailable"));
    const generator = fakeGenerator({ narrative: "[T1] 완료.", highlight: "완료." });
    const warn = vi.fn();
    const service = new SessionStoryFoldService({
      repository, generator, configService: { read: () => ({ ...CONFIG, storyFoldMaxBatchesPerRun: 1 }) },
      logger: { debug: vi.fn(), info: vi.fn(), warn }, nowMs: () => 100,
    });
    await service.foldIfNeeded("session-a");
    await service.foldIfNeeded("session-a");
    await service.foldIfNeeded("session-b");
    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: "fold_error", foldKind: "batch", summaryCount: 5,
      promptChars: expect.any(Number), timeoutMs: 90_000, elapsedMs: expect.any(Number),
    }), "Session story fold failed");
  });

  it.each(["batch", "completed_chunk", "completed"] as const)(
    "does not cool down a %s storage conflict",
    async (kind) => {
      const summaries = bulkSummaries(kind === "completed_chunk" ? 41 : 5);
      const repository = fakeRepository({ count: summaries.length, totalCount: summaries.length, summaries });
      if (kind === "batch") repository.countUnfoldedSummaries.mockReset().mockResolvedValue(10);
      if (kind === "completed_chunk") repository.loadUnfoldedSummaries.mockResolvedValue(summaries.slice(0, 40));
      if (kind === "completed") repository.storeCompletedDigest.mockResolvedValue(false);
      else repository.storeDigest.mockResolvedValue(false);
      const generator = fakeGenerator({ narrative: "[T1] 완료.", highlight: "완료." });
      const service = new SessionStoryFoldService({
        repository, generator, configService: { read: () => CONFIG },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, nowMs: () => 100,
      });
      await runFold(service, kind);
      await runFold(service, kind);
      expect(generator.generate).toHaveBeenCalledTimes(2);
    },
  );
  it("folds the five oldest summaries at the threshold and advances the durable watermark atomically", async () => {
    const summaries = practicalSummaryFixture();
    const repository = fakeRepository({ count: 10, summaries });
    const generator = fakeGenerator({
      narrative: "[T1] 첫 요청을 처리했다. [T2-T5] 구현 방향을 정하고 검증했다.",
      highlight: "요청을 분석했다. 구현 방향을 정했다. 정책을 보존했다. 검증을 마쳤다. 다음 작업의 기반을 남겼다.",
    });
    const info = vi.fn();
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator,
      logger: { debug: vi.fn(), info, warn: vi.fn() },
      nowMs: () => 150,
    });

    await service.foldIfNeeded("session-a");

    expect(repository.loadUnfoldedSummaries).toHaveBeenCalledWith(
      "session-a",
      null,
      5,
    );
    expect(generator.generate).toHaveBeenCalledWith(
      expect.stringContaining("[T1] 첫 요청"),
      expect.objectContaining({
        model: "gpt-5.6-terra",
        storyModel: "gpt-5.6-terra",
      }),
      expect.objectContaining({ maxAttempts: 1 }),
    );
    expect(repository.storeDigest).toHaveBeenCalledWith({
      sessionId: "session-a",
      narrative: "[T1] 첫 요청을 처리했다. [T2-T5] 구현 방향을 정하고 검증했다.",
      highlight: "요청을 분석했다. 구현 방향을 정했다. 정책을 보존했다. 검증을 마쳤다. 다음 작업의 기반을 남겼다.",
      narrativeThroughEventId: 52,
      expectedVersion: 0,
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        model: "gpt-5.6-terra",
        markerInversionPairs: 0,
        foldedTurnCount: 5,
        narrativeThroughEventId: 52,
      }),
      "Session story fold stored",
    );
  });

  it("does not load a batch or call Codex below the hot-reloaded threshold", async () => {
    const repository = fakeRepository({ count: 9 });
    const generator = fakeGenerator({
      narrative: "[T1] 호출되면 안 된다.",
      highlight: "하나. 둘. 셋. 넷. 다섯.",
    });
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    await service.foldIfNeeded("session-a");

    expect(repository.loadUnfoldedSummaries).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
    expect(repository.storeDigest).not.toHaveBeenCalled();
  });

  it("retries one malformed structured result and stores the second valid result", async () => {
    const repository = fakeRepository({ count: 10 });
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: "{\"narrative\":", model: "test", latencyMs: 3, attempts: 1 })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          narrative: "[T1] 복구했다.",
          highlight: "하나. 둘. 셋. 넷. 다섯.",
        }),
        model: "test",
        latencyMs: 4,
        attempts: 1,
      });
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator: { generate },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    await service.foldIfNeeded("session-a");

    expect(generate).toHaveBeenCalledTimes(2);
    expect(repository.storeDigest).toHaveBeenCalledTimes(1);
  });

  it("leaves the watermark and digest untouched after two invalid results", async () => {
    const repository = fakeRepository({ count: 10 });
    const warn = vi.fn();
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            narrative: "마커가 없는 줄거리",
            highlight: "하나. 둘. 셋. 넷. 다섯.",
          }),
          model: "test",
          latencyMs: 1,
          attempts: 1,
        }),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn },
    });

    await service.foldIfNeeded("session-a");

    expect(repository.storeDigest).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid_structured_output",
        error: expect.stringContaining("no parseable turn marker"),
      }),
      "Session story fold failed",
    );
  });

  it("prevents duplicate in-flight folds for the same session", async () => {
    let release: (() => void) | undefined;
    const repository = fakeRepository({ count: 10 });
    repository.loadDigest.mockImplementation(async () =>
      await new Promise<SessionStoryDigest | null>((resolve) => {
        release = () => resolve(null);
      })
    );
    const info = vi.fn();
    const generator = fakeGenerator({
      narrative: "[T1] 완료했다.",
      highlight: "하나. 둘. 셋. 넷. 다섯.",
    });
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator,
      logger: { debug: vi.fn(), info, warn: vi.fn() },
    });

    const first = service.foldIfNeeded("session-a");
    const second = service.foldIfNeeded("session-a");
    await second;
    release?.();
    await first;

    expect(repository.loadDigest).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "already_in_flight" }),
      "Session story fold skipped",
    );
    repository.loadDigest.mockResolvedValue(null);
    repository.countUnfoldedSummaries.mockReset().mockResolvedValueOnce(10).mockResolvedValue(0);
    await service.foldIfNeeded("session-a");
    expect(generator.generate).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 3, 4, 5])(
    "finalizes every remaining tail when a completed session has %s unfolded summaries",
    async (tailCount) => {
      const all = practicalSummaryFixture();
      const tails = all.slice(all.length - tailCount);
      const digest = tailCount === all.length
        ? null
        : {
            sessionId: "session-a",
            narrative: "[T1] 이전 줄거리.",
            highlight: "이전 하이라이트.",
            narrativeThroughEventId: all[all.length - tailCount - 1]?.eventId ?? 0,
            foldCount: 1,
            version: 2,
            createdAt: new Date("2026-07-31T00:00:00.000Z"),
            updatedAt: new Date("2026-07-31T00:10:00.000Z"),
          };
      const repository = fakeRepository({
        count: tailCount,
        totalCount: 5,
        summaries: tails,
        digest,
      });
      const generator = fakeGenerator({
        narrative: "[T1-T5] 최종 줄거리.",
        highlight: "하나. 둘. 셋. 넷. 다섯.",
      });
      const service = new SessionStoryFoldService({
        repository,
        configService: { read: () => CONFIG },
        generator,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      });
      const completedAt = new Date("2026-07-31T00:30:00.000Z");
      const completedBefore = new Date("2026-07-31T01:00:00.000Z");

      await service.foldCompletedIfNeeded(
        { sessionId: "session-a", completedAt },
        completedBefore,
        5,
      );

      expect(repository.loadUnfoldedSummaries).toHaveBeenCalledWith(
        "session-a",
        digest?.narrativeThroughEventId ?? null,
        tailCount,
      );
      expect(repository.storeCompletedDigest).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-a",
          narrativeThroughEventId: tails[tails.length - 1]?.eventId,
          expectedVersion: digest?.version ?? 0,
          completedAt,
          completedBefore,
          minimumSummaryCount: 5,
        }),
      );
    },
  );

  it("does not finalize a completed session with fewer than five summaries", async () => {
    const repository = fakeRepository({
      count: 4,
      totalCount: 4,
      summaries: practicalSummaryFixture().slice(0, 4),
    });
    const generator = fakeGenerator({
      narrative: "생성되면 안 된다.",
      highlight: "생성되면 안 된다.",
    });
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    await service.foldCompletedIfNeeded(
      {
        sessionId: "session-a",
        completedAt: new Date("2026-07-31T00:30:00.000Z"),
      },
      new Date("2026-07-31T01:00:00.000Z"),
      5,
    );

    expect(generator.generate).not.toHaveBeenCalled();
    expect(repository.storeCompletedDigest).not.toHaveBeenCalled();
  });

  it("rechecks completion state at the final CAS and skips a resumed session", async () => {
    const repository = fakeRepository({
      count: 1,
      totalCount: 5,
      summaries: [practicalSummaryFixture()[4]!],
      storeCompleted: false,
    });
    const info = vi.fn();
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator: fakeGenerator({
        narrative: "[T1-T5] 후보 줄거리.",
        highlight: "하나. 둘. 셋. 넷. 다섯.",
      }),
      logger: { debug: vi.fn(), info, warn: vi.fn() },
    });

    await service.foldCompletedIfNeeded(
      {
        sessionId: "session-a",
        completedAt: new Date("2026-07-31T00:30:00.000Z"),
      },
      new Date("2026-07-31T01:00:00.000Z"),
      5,
    );

    expect(repository.storeDigest).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "completion_guard_conflict" }),
      "Session story fold skipped",
    );
  });

  it("keeps folding batches until it reaches the per-run batch limit", async () => {
    const firstBatch = practicalSummaryFixture();
    const secondBatch = practicalSummaryFixture().map((summary) => ({
      ...summary,
      eventId: summary.eventId + 100,
      turnNumber: summary.turnNumber + 5,
    }));
    const repository = fakeRepository({
      count: 10,
      afterCount: 10,
      summaries: firstBatch,
    });
    repository.loadUnfoldedSummaries
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);
    const generator = fakeGenerator({
      narrative: "[T1] 첫 요청을 처리했다. [T2-T5] 구현 방향을 정하고 검증했다.",
      highlight: "요청을 분석했다. 구현 방향을 정했다. 정책을 보존했다. 검증을 마쳤다. 다음 작업의 기반을 남겼다.",
    });
    const service = new SessionStoryFoldService({
      repository,
      configService: {
        read: () => ({ ...CONFIG, storyFoldMaxBatchesPerRun: 2 }),
      },
      generator,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    await service.foldIfNeeded("session-a");

    expect(repository.loadUnfoldedSummaries).toHaveBeenCalledTimes(2);
    expect(repository.storeDigest).toHaveBeenCalledTimes(2);
    expect(generator.generate.mock.calls[1]?.[0]).toContain(
      "첫 요청을 처리했다",
    );
    expect(repository.storeDigest.mock.calls[1]?.[0]).toMatchObject({
      narrativeThroughEventId: 152,
      expectedVersion: 1,
    });
  });

  it("stops without storing when the story generation keeps failing", async () => {
    const repository = fakeRepository({ count: 10 });
    const generate = vi.fn().mockRejectedValue(new Error("codex unavailable"));
    const warn = vi.fn();
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator: { generate },
      logger: { debug: vi.fn(), info: vi.fn(), warn },
    });

    await service.foldIfNeeded("session-a");

    expect(generate).toHaveBeenCalledTimes(2);
    expect(repository.storeDigest).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "invalid_structured_output",
        error: "codex unavailable",
      }),
      "Session story fold failed",
    );
  });

  it("folds a completed tail above the summary cap in capped batches", async () => {
    const summaries = bulkSummaries(45);
    const repository = fakeRepository({
      count: 45,
      totalCount: 45,
      summaries,
    });
    repository.loadUnfoldedSummaries
      .mockResolvedValueOnce(summaries.slice(0, 40))
      .mockResolvedValueOnce(summaries.slice(40));
    const generator = fakeGenerator({
      narrative: "[T1-T45] 최종 줄거리.",
      highlight: "하나. 둘. 셋. 넷. 다섯.",
    });
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    const completedAt = new Date("2026-07-31T00:30:00.000Z");

    await service.foldCompletedIfNeeded(
      { sessionId: "session-a", completedAt },
      new Date("2026-07-31T01:00:00.000Z"),
      5,
    );

    expect(repository.loadUnfoldedSummaries).toHaveBeenNthCalledWith(
      1,
      "session-a",
      null,
      40,
    );
    expect(repository.loadUnfoldedSummaries).toHaveBeenNthCalledWith(
      2,
      "session-a",
      summaries[39]?.eventId,
      5,
    );
    expect(repository.storeDigest).toHaveBeenCalledTimes(1);
    expect(repository.storeCompletedDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        narrativeThroughEventId: summaries[44]?.eventId,
        expectedVersion: 1,
        completedAt,
      }),
    );
    expect(generator.generate).toHaveBeenCalledTimes(2);
  });

  it("observes marker inversions without rewriting the model prose", () => {
    expect(markerOrderStats(
      "[T4] 네 번째 사건이다. [T2-T3] 앞선 결정이다. [T5] 마무리다.",
    )).toEqual({
      markerCount: 3,
      inversionPairs: 1,
    });
  });
});

async function runFold(service: SessionStoryFoldService, kind: "batch" | "completed_chunk" | "completed"): Promise<void> {
  if (kind === "batch") return await service.foldIfNeeded("session-a");
  return await service.foldCompletedIfNeeded(
    { sessionId: "session-a", completedAt: new Date("2026-07-31T00:30:00Z") },
    new Date("2026-07-31T01:00:00Z"), 5,
  );
}

function practicalSummaryFixture(): SessionStoryTurnSummary[] {
  return [
    summary(12, 1, "첫 요청", 2, 10),
    summary(24, 2, "고아 발화 뒤 재개", 13, 22),
    summary(31, 3, "인터럽트 이후 방향 변경", 25, 29),
    summary(44, 4, "정책 결정", 35, 41),
    summary(52, 5, "검증 완료", 46, 50),
  ];
}

function bulkSummaries(count: number): SessionStoryTurnSummary[] {
  return Array.from({ length: count }, (_, index) =>
    summary(
      (index + 1) * 10,
      index + 1,
      `요약 ${index + 1}`,
      (index + 1) * 10 - 8,
      (index + 1) * 10 - 2,
    )
  );
}

function summary(
  eventId: number,
  turnNumber: number,
  content: string,
  turnStartEventId: number,
  finalResponseEventId: number,
): SessionStoryTurnSummary {
  return {
    eventId,
    turnNumber,
    content,
    turnStartEventId,
    finalResponseEventId,
    createdAt: new Date(eventId * 1_000),
  };
}

function fakeRepository(options: {
  count: number;
  afterCount?: number;
  totalCount?: number;
  summaries?: SessionStoryTurnSummary[];
  digest?: SessionStoryDigest | null;
  storeCompleted?: boolean;
}) {
  return {
    loadDigest: vi.fn().mockResolvedValue(options.digest ?? null),
    countUnfoldedSummaries: vi.fn()
      .mockResolvedValueOnce(options.count)
      .mockResolvedValue(options.afterCount ?? 0),
    countTurnSummaries: vi.fn().mockResolvedValue({
      totalCount: options.totalCount ?? options.count,
      digestedCount: (options.totalCount ?? options.count) - options.count,
      undigestedCount: options.count,
    }),
    loadUnfoldedSummaries: vi.fn().mockResolvedValue(
      options.summaries ?? practicalSummaryFixture(),
    ),
    listCompletedFoldCandidates: vi.fn().mockResolvedValue([]),
    storeDigest: vi.fn().mockResolvedValue(true),
    storeCompletedDigest: vi.fn().mockResolvedValue(options.storeCompleted ?? true),
  } satisfies Record<keyof SessionStoryRepositoryPort, ReturnType<typeof vi.fn>>;
}

function fakeGenerator(output: {
  narrative: string;
  highlight: string;
}): SessionStoryGenerator & { generate: ReturnType<typeof vi.fn> } {
  return {
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify(output),
      model: "gpt-5.6-terra",
      latencyMs: 10,
      attempts: 1,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  };
}
