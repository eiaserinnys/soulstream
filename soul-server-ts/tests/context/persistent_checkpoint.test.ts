import { describe, expect, it } from "vitest";

import {
  buildPersistentCheckpoint,
  PERSISTENT_CHECKPOINT_BUDGET,
  type GenerationCheckpointMaterial,
  type SupervisedCardSnapshot,
} from "../../src/context/persistent_checkpoint.js";
import { estimateClaudeTextTokens } from "../../src/task/claude_context_recovery.js";

const ownSessionId = "4f795856-a9bf-4ae2-8adb-2e8ea15f9951";
const ownCardId = "7349e4a2-d679-4702-83b4-fe7c3b1f2511";

function makeMaterial(overrides: Partial<GenerationCheckpointMaterial> = {}): GenerationCheckpointMaterial {
  return {
    story: {
      highlight: null,
      narrative: "",
      unfoldedTurnSummaries: [],
      narrativeThroughEventId: null,
      foldCount: 0,
      updatedAt: null,
    },
    lastSummarizedFinalResponseEventId: null,
    recent: { records: [], omittedUnsummarized: 0 },
    childSessions: [],
    childSessionTotal: 0,
    totals: { events: 0, turnSummaries: 0 },
    ...overrides,
  };
}

function makeCards(overrides: Partial<SupervisedCardSnapshot> = {}): SupervisedCardSnapshot {
  return {
    capturedAt: "2026-10-05T00:00:00.000Z",
    counts: { running: 1, blocked: 1, review: 0, queued: 0, todo: 0 },
    cards: [
      {
        id: ownCardId,
        title: "영구 관제 세션",
        status: "running",
        blockedKind: null,
        assignee: { kind: "session", agentId: "roselin", sessionId: ownSessionId },
      },
      {
        id: "1d714b91-272e-4336-9796-6cdbb0ab009e",
        title: "작업이 막혀 있습니다",
        status: "blocked",
        blockedKind: "question",
        assignee: { kind: "human", agentId: null, sessionId: null },
      },
    ],
    openQuestions: [
      {
        id: "14d46f1b-0a17-49ed-b3ea-c8fa4bcfd1c1",
        cardId: ownCardId,
        cardTitle: "영구 관제 세션",
        text: "이 카드의 판단을 기다립니다.",
        askedAt: "2026-10-04T23:59:00.000Z",
      },
    ],
    openQuestionTotal: 1,
    ...overrides,
  };
}

function itemText(input: Parameters<typeof buildPersistentCheckpoint>[0], budget?: Parameters<typeof buildPersistentCheckpoint>[1]) {
  const result = buildPersistentCheckpoint(input, budget);
  return { text: String(result.item.content), stats: result.stats };
}

describe("buildPersistentCheckpoint", () => {
  it("writes complete card and session IDs through the identifier formatter", () => {
    const childId = "8a13f280-86be-4bd5-a2e4-9199f82aa63c";
    const childCardId = "61954137-8402-4ca3-947e-4105bf7a8139";
    const { text } = itemText({
      material: makeMaterial({
        childSessions: [{
          sessionId: childId,
          displayName: "P6 실행 세션",
          agentId: "roselin",
          modelPreset: "codex-6-luna",
          status: "running",
          cardId: childCardId,
          createdAt: "2026-10-05T00:00:00.000Z",
        }],
        childSessionTotal: 1,
      }),
      cards: makeCards(),
      standingInstructions: [],
      ownSessionId,
    });

    expect(text).toContain(`- ${ownCardId} 「영구 관제 세션」 실행 중 · 담당 이 세션`);
    expect(text).toContain(childId);
    expect(text).toContain(childCardId);
    expect(text).not.toContain(ownCardId.slice(0, 8) + "…");
    expect(text).toContain("막힘(질문)");
    expect(text).toContain("담당 사용자");
    expect(text).toContain("이 카드의 판단을 기다립니다.");
  });

  it("keeps the status section within its budget and gives unused room to cards", () => {
    const queriedCards = Array.from({ length: 60 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      title: `상태 카드 ${"긴 제목".repeat(12)} ${index}`,
      status: "queued" as const,
      blockedKind: null,
      assignee: { kind: null, agentId: null, sessionId: null },
    }));
    const empty = makeCards({
      counts: { running: 0, blocked: 0, review: 0, queued: 30, todo: 0 },
      cards: queriedCards.slice(0, 30),
      openQuestions: [],
      openQuestionTotal: 0,
    });
    const fullState = makeMaterial({
      childSessionTotal: 20,
      childSessions: Array.from({ length: 20 }, (_, index) => ({
        sessionId: `session-${index}`,
        displayName: `실행 세션 ${index}`,
        agentId: "worker",
        modelPreset: "codex-6-luna",
        status: "running",
        cardId: `child-card-${index}`,
        createdAt: "2026-10-05T00:00:00.000Z",
      })),
    });
    const questions = makeCards({
      ...empty,
      openQuestionTotal: 20,
      openQuestions: Array.from({ length: 10 }, (_, index) => ({
        id: `question-${index}`,
        cardId: `question-card-${index}`,
        cardTitle: "질문",
        text: "질문 본문 ".repeat(20),
        askedAt: "2026-10-05T00:00:00.000Z",
      })),
    });
    const budget = PERSISTENT_CHECKPOINT_BUDGET;
    const emptyResult = itemText({ material: makeMaterial(), cards: empty, standingInstructions: [], ownSessionId }, budget);
    const fullResult = itemText({ material: fullState, cards: questions, standingInstructions: [], ownSessionId }, budget);
    const truncatedQuery = makeCards({
      ...questions,
      counts: { ...questions.counts, queued: 70 },
      cards: queriedCards,
    });
    const truncatedQueryResult = itemText({ material: fullState, cards: truncatedQuery, standingInstructions: [], ownSessionId }, budget);

    expect(emptyResult.stats.sections.state).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.stateTokens);
    expect(fullResult.stats.sections.state).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.stateTokens);
    expect(truncatedQueryResult.stats.sections.state).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.stateTokens);
    expect((emptyResult.text.match(/상태 카드/g) ?? []).length)
      .toBeGreaterThan((fullResult.text.match(/상태 카드/g) ?? []).length);
    expect((fullResult.text.match(/상태 카드/g) ?? []).length).toBe(10);
    expect(fullResult.text).toContain("외 20장 생략(대기 20)");
    expect((truncatedQueryResult.text.match(/상태 카드/g) ?? []).length).toBe(10);
    expect(truncatedQueryResult.text).toContain("외 60장 생략(대기 60)");
    expect(fullResult.text).toMatch(/외 \d+개/);
  });

  it("omits empty instructions, marks omitted summaries, and reports measured sections", () => {
    const story = {
      highlight: null,
      narrative: "현재까지의 줄거리입니다.",
      unfoldedTurnSummaries: Array.from({ length: 5 }, (_, index) => ({
        eventId: index + 10,
        turnNumber: index + 1,
        content: `턴 ${index + 1} 요약 ${"한".repeat(40)}`,
        turnStartEventId: index + 8,
        finalResponseEventId: index + 10,
        createdAt: new Date("2026-10-05T00:00:00.000Z"),
      })),
      narrativeThroughEventId: 8,
      foldCount: 1,
      updatedAt: null,
    };
    const material = makeMaterial({
      story,
      lastSummarizedFinalResponseEventId: 14,
      recent: {
        records: [
          { event_id: 13, event_type: "user_message", text: "요약 전 요청", created_at: "2026-10-04T00:00:00.000Z" },
          { event_id: 15, event_type: "user_message", text: "미요약 구간 요청", created_at: "2026-10-05T00:00:01.000Z" },
          { event_id: 16, event_type: "assistant_message", text: "미요약 구간 답변", created_at: "2026-10-05T00:00:02.000Z" },
        ],
        omittedUnsummarized: 0,
      },
      totals: { events: 16, turnSummaries: 5 },
    });
    const budget = { ...PERSISTENT_CHECKPOINT_BUDGET, summaryTokens: 70, totalTokens: 2_000 };
    const { text, stats } = itemText({ material, cards: makeCards(), standingInstructions: [], ownSessionId }, budget);

    expect(text).not.toContain("지속 지침");
    expect(text).toContain("T1–T");
    expect(text).toContain("미요약 구간 요청");
    expect(text).toContain("미요약 구간 답변");
    expect(stats.sections.summaries).toBeLessThanOrEqual(70);
    expect(stats.sections.state).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.stateTokens);
    expect(stats.estimatedTokens).toBe(estimateClaudeTextTokens(text));
    expect(stats.chars).toBe(text.length);
  });

  it("reserves room for the full unsummarized range and stays within the overall budget", () => {
    const records = [
      { event_id: 101, event_type: "user_message", text: "요약되지 않은 요청 ".repeat(80), created_at: "2026-10-05T00:00:01.000Z" },
      { event_id: 102, event_type: "assistant_message", text: "요약되지 않은 답변 ".repeat(80), created_at: "2026-10-05T00:00:02.000Z" },
    ];
    const material = makeMaterial({
      story: { ...makeMaterial().story, narrative: "짧은 줄거리" },
      lastSummarizedFinalResponseEventId: 100,
      recent: {
        records: [
          { event_id: 90, event_type: "user_message", text: "직전 교환", created_at: "2026-10-04T00:00:00.000Z" },
          ...records,
        ],
        omittedUnsummarized: 7,
      },
    });
    const budget = { ...PERSISTENT_CHECKPOINT_BUDGET, totalTokens: 20_000 };
    const { text, stats } = itemText({ material, cards: makeCards(), standingInstructions: [], ownSessionId }, budget);

    expect(text).toContain("요약되지 않은 요청");
    expect(text).toContain("요약되지 않은 답변");
    expect(text).toContain("외 7개 미요약 이벤트 생략");
    expect(stats.estimatedTokens).toBeLessThanOrEqual(20_000);
  });
});
