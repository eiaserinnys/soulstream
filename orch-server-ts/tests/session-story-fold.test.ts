import { describe, expect, it, vi } from "vitest";

import {
  markerOrderStats,
  SessionStoryFoldService,
  type SessionStoryGenerator,
} from "../src/turn-summary/session_story_fold_service.js";
import type {
  SessionStoryDigest,
  SessionStoryRepositoryPort,
  UnfoldedTurnSummary,
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
  storyNarrativeMaxChars: 1_500,
  provider: "codex",
  model: "gpt-5.6-luna",
  storyModel: "gpt-5.6-terra",
  reasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
  codexConcurrencyLimit: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [],
};

describe("SessionStoryFoldService", () => {
  it("folds the five oldest summaries at the threshold and advances the durable watermark atomically", async () => {
    const summaries = practicalSummaryFixture();
    const repository = fakeRepository({ count: 10, summaries });
    const generator = fakeGenerator({
      narrative: "[T1] 첫 요청을 처리했다. [T2-T5] 구현 방향을 정하고 검증했다.",
      highlight: "요청을 분석했다. 구현 방향을 정했다. 정책을 보존했다. 검증을 마쳤다. 다음 작업의 기반을 남겼다.",
    });
    const debug = vi.fn();
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator,
      logger: { debug, info: vi.fn(), warn: vi.fn() },
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
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        model: "gpt-5.6-terra",
        markerInversionPairs: 0,
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
    const debug = vi.fn();
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
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    await service.foldIfNeeded("session-a");

    expect(repository.storeDigest).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "invalid_structured_output" }),
      "Session story fold skipped",
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
    const debug = vi.fn();
    const service = new SessionStoryFoldService({
      repository,
      configService: { read: () => CONFIG },
      generator: fakeGenerator({
        narrative: "[T1] 완료했다.",
        highlight: "하나. 둘. 셋. 넷. 다섯.",
      }),
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    const first = service.foldIfNeeded("session-a");
    const second = service.foldIfNeeded("session-a");
    await second;
    release?.();
    await first;

    expect(repository.loadDigest).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "already_in_flight" }),
      "Session story fold skipped",
    );
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

function practicalSummaryFixture(): UnfoldedTurnSummary[] {
  return [
    summary(12, 1, "첫 요청", 2, 10),
    summary(24, 2, "고아 발화 뒤 재개", 13, 22),
    summary(31, 3, "인터럽트 이후 방향 변경", 25, 29),
    summary(44, 4, "정책 결정", 35, 41),
    summary(52, 5, "검증 완료", 46, 50),
  ];
}

function summary(
  eventId: number,
  turnNumber: number,
  content: string,
  turnStartEventId: number,
  finalResponseEventId: number,
): UnfoldedTurnSummary {
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
  summaries?: UnfoldedTurnSummary[];
}) {
  return {
    loadDigest: vi.fn().mockResolvedValue(null),
    countUnfoldedSummaries: vi.fn().mockResolvedValue(options.count),
    loadUnfoldedSummaries: vi.fn().mockResolvedValue(
      options.summaries ?? practicalSummaryFixture(),
    ),
    storeDigest: vi.fn().mockResolvedValue(true),
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
