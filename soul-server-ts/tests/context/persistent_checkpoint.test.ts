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

function makeStandingInstructions(): string[] {
  return Array.from({ length: 36 }, (_, index) => index === 35
    ? "카드 이름 인용 규칙: 카드 제목은 원문 그대로 「」로 감싸 정확히 인용한다."
    : `지속 규칙 ${index + 1}: 주어진 정보의 순서를 유지하고 중요한 조건을 빠뜨리지 않는다. 구체적인 근거를 함께 살피고 정확한 표현을 사용한다. 실행 전에 관련 범위를 확인하고 필요 없는 내용을 덧붙이지 않는다.`);
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

  describe("card numbers", () => {
    const numberedChild = {
      sessionId: "8a13f280-86be-4bd5-a2e4-9199f82aa63c",
      displayName: "P6 실행 세션",
      agentId: "roselin",
      modelPreset: "codex-6-luna",
      status: "running" as const,
      cardId: "61954137-8402-4ca3-947e-4105bf7a8139",
      createdAt: "2026-10-05T00:00:00.000Z",
    };

    function buildText(
      childSessions: GenerationCheckpointMaterial["childSessions"],
      cards: SupervisedCardSnapshot,
    ): string {
      return itemText({
        material: makeMaterial({ childSessions, childSessionTotal: childSessions.length }),
        cards,
        standingInstructions: [],
        ownSessionId,
      }).text;
    }

    function numberedCards(): SupervisedCardSnapshot {
      const base = makeCards();
      return {
        ...base,
        cards: [
          { ...base.cards[0]!, number: 412 },
          { ...base.cards[1]!, number: 413 },
        ],
        openQuestions: [{ ...base.openQuestions[0]!, cardNumber: 412 }],
      };
    }

    it("writes #N for cards and questions, #N.sK for sessions on a numbered card, and tells the model to use them", () => {
      const text = buildText([{ ...numberedChild, reference: "#412.s2" }], numberedCards());

      expect(text).toContain(`- #412 「영구 관제 세션」 실행 중 · 담당 이 세션`);
      expect(text).toContain("- #413 「작업이 막혀 있습니다」 막힘(질문) · 담당 사용자");
      expect(text).toContain("- #412 「영구 관제 세션」: 이 카드의 판단을 기다립니다.");
      expect(text).toContain("- #412.s2 「P6 실행 세션」 · roselin / codex-6-luna\n");
      expect(text).not.toContain("· 카드");
      expect(text).not.toContain(ownCardId);
      expect(text).not.toContain(numberedChild.sessionId);
      expect(text).not.toContain(numberedChild.cardId);
      expect(text).toContain("`#412`, `#412.s2` 같은 번호는 도구의 `card_id`, `session_id` 인자에 그대로 쓸 수 있습니다.");
    });

    it("keeps full IDs when the numbers are null or the fields are absent", () => {
      const base = makeCards();
      const nulls: SupervisedCardSnapshot = {
        ...base,
        cards: base.cards.map((card) => ({ ...card, number: null })),
        openQuestions: base.openQuestions.map((question) => ({ ...question, cardNumber: null })),
      };
      const withNulls = buildText([{ ...numberedChild, reference: null }], nulls);
      const withoutFields = buildText([numberedChild], base);

      for (const text of [withNulls, withoutFields]) {
        expect(text).toContain(`- ${ownCardId} 「영구 관제 세션」 실행 중 · 담당 이 세션`);
        expect(text).toContain(`- ${ownCardId} 「영구 관제 세션」: 이 카드의 판단을 기다립니다.`);
        expect(text).toContain(`- ${numberedChild.sessionId} 「P6 실행 세션」 · roselin / codex-6-luna · 카드 ${numberedChild.cardId}`);
        expect(text).not.toMatch(/- #\d/);
      }
    });

    it("tails a session on a numberless card with the full card ID, and a cardless session with nothing", () => {
      const cardless = { ...numberedChild, sessionId: "5d0c1a2b-1111-4222-8333-444455556666", cardId: null, reference: null };
      const text = buildText([{ ...numberedChild, reference: null }, cardless], numberedCards());

      expect(text).toContain(`- ${numberedChild.sessionId} 「P6 실행 세션」 · roselin / codex-6-luna · 카드 ${numberedChild.cardId}`);
      expect(text).toContain(`- ${cardless.sessionId} 「P6 실행 세션」 · roselin / codex-6-luna\n`);
    });
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
    const budget = { ...PERSISTENT_CHECKPOINT_BUDGET, summaryTokens: 70, totalTokens: 2_000, recentMinimumTokens: 300 };
    const { text, stats } = itemText({ material, cards: makeCards(), standingInstructions: [], ownSessionId }, budget);

    expect(text).not.toContain("지속 지시");
    expect(text).toContain("T1–T");
    expect(text).toContain("미요약 구간 요청");
    expect(text).toContain("미요약 구간 답변");
    expect(stats.sections.summaries).toBeLessThanOrEqual(70);
    expect(stats.sections.state).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.stateTokens);
    expect(stats.estimatedTokens).toBe(estimateClaudeTextTokens(text));
    expect(stats.chars).toBe(text.length);
  });

  it("preserves all active instructions when their text exceeds the former instruction limit", () => {
    const instructions = makeStandingInstructions();
    const instructionTokens = estimateClaudeTextTokens(instructions.join("\n"));
    const { text } = itemText({
      material: makeMaterial(),
      cards: makeCards(),
      standingInstructions: instructions,
      ownSessionId,
    });

    expect(instructionTokens).toBeGreaterThan(2_500);
    expect(instructionTokens).toBeLessThan(PERSISTENT_CHECKPOINT_BUDGET.totalTokens);
    expect(text).toContain(`## 지속 지시\n${instructions.join("\n")}`);
    expect(text).not.toContain("persistent_checkpoint_instructions truncated");
  });

  it("keeps full instructions and bounds complete conversation sections together", () => {
    const instructions = makeStandingInstructions();
    const summaries = Array.from({ length: 4 }, (_, index) => ({
      eventId: 200 + index,
      turnNumber: 20 + index,
      content: `요약 ${index + 1} ${"이전 대화의 핵심 내용과 실행 결과를 보존한다. ".repeat(150)}`,
      turnStartEventId: 190 + index,
      finalResponseEventId: 200 + index,
      createdAt: new Date("2026-10-05T00:00:00.000Z"),
    }));
    const material = makeMaterial({
      story: {
        ...makeMaterial().story,
        narrative: "줄거리에서 확인된 목표와 결정을 보존한다. ".repeat(1_200),
        unfoldedTurnSummaries: summaries,
      },
      lastSummarizedFinalResponseEventId: 199,
      recent: {
        records: [
          { event_id: 201, event_type: "user_message", text: "최근 요청의 조건과 범위를 확인한다. ".repeat(1_000), created_at: "2026-10-05T00:00:01.000Z" },
          { event_id: 202, event_type: "assistant_message", text: "최근 응답의 근거와 다음 행동을 기록한다. ".repeat(1_000), created_at: "2026-10-05T00:00:02.000Z" },
        ],
        omittedUnsummarized: 12,
      },
      totals: { events: 202, turnSummaries: 24 },
    });
    const { text, stats } = itemText({ material, cards: makeCards(), standingInstructions: instructions, ownSessionId });

    expect(text).toContain("카드 이름 인용 규칙: 카드 제목은 원문 그대로 「」로 감싸 정확히 인용한다.");
    expect(text).toContain("## 대화 줄거리");
    expect(text).toContain("## 미접힘 턴 요약");
    expect(text).toContain("## 최근 원문");
    expect(stats.sections.story).toBeGreaterThan(0);
    expect(stats.sections.story).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.narrativeTokens);
    expect(stats.sections.summaries).toBeGreaterThan(0);
    expect(stats.sections.summaries).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.summaryTokens);
    expect(stats.sections.recent).toBeGreaterThan(0);
    expect(stats.estimatedTokens).toBeLessThanOrEqual(PERSISTENT_CHECKPOINT_BUDGET.totalTokens);
  });

  it("does not exceed a narrow remainder to fit recent text or its omission marker", () => {
    const base = itemText({
      material: makeMaterial(),
      cards: makeCards(),
      standingInstructions: [],
      ownSessionId,
    });
    const recentMaterial = makeMaterial({
      story: { ...makeMaterial().story, narrative: "conversation marker" },
      recent: {
        records: [{
          event_id: 301,
          event_type: "user_message",
          text: "큰 최근 요청 ".repeat(1_000),
          created_at: "2026-10-05T00:00:00.000Z",
        }],
        omittedUnsummarized: 3,
      },
    });
    const budget = {
      ...PERSISTENT_CHECKPOINT_BUDGET,
      totalTokens: base.stats.estimatedTokens + 5,
      recentMinimumTokens: 4_000,
    };
    const { text, stats } = itemText({
      material: recentMaterial,
      cards: makeCards(),
      standingInstructions: [],
      ownSessionId,
    }, budget);

    expect(stats.estimatedTokens).toBeLessThanOrEqual(budget.totalTokens);
    expect(text).not.toContain("conversation marker");
    expect(text).not.toContain("## 최근 원문");
  });

  it("resets prior conversation material while keeping current state and selected instructions", () => {
    const material = makeMaterial({
      story: {
        highlight: null,
        narrative: "reset-story-marker",
        unfoldedTurnSummaries: [{
          eventId: 12,
          turnNumber: 12,
          content: "reset-summary-marker",
          turnStartEventId: 11,
          finalResponseEventId: 12,
          createdAt: new Date("2026-10-05T00:00:00.000Z"),
        }],
        narrativeThroughEventId: 12,
        foldCount: 1,
        updatedAt: new Date("2026-10-05T00:00:00.000Z"),
      },
      recent: {
        records: [{
          event_id: 13,
          event_type: "user_message",
          text: "reset-recent-marker",
          created_at: "2026-10-05T00:00:00.000Z",
        }],
        omittedUnsummarized: 0,
      },
      totals: { events: 13, turnSummaries: 12 },
    });
    const { text, stats } = itemText({
      material,
      cards: makeCards(),
      standingInstructions: ["reset-instruction-marker"],
      ownSessionId,
      resetContext: true,
      keepInstructions: true,
    } as Parameters<typeof buildPersistentCheckpoint>[0]);

    expect(text).toContain("## 현재 상태");
    expect(text).toContain("## 지속 지시\nreset-instruction-marker");
    expect(text).not.toContain("reset-story-marker");
    expect(text).not.toContain("reset-summary-marker");
    expect(text).not.toContain("reset-recent-marker");
    expect(stats.sections).toMatchObject({ story: 0, summaries: 0, recent: 0 });
    expect(stats.summarizedThroughTurn).toBeNull();
    expect(stats.recentFromEventId).toBeNull();
    expect(stats.recentToEventId).toBeNull();
  });

  it("can omit stored instructions from a reset checkpoint without changing the input", () => {
    const standingInstructions = ["stored-instruction-marker"];
    const { text } = itemText({
      material: makeMaterial(),
      cards: makeCards(),
      standingInstructions,
      ownSessionId,
      resetContext: true,
      keepInstructions: false,
    } as Parameters<typeof buildPersistentCheckpoint>[0]);

    expect(text).toContain("## 현재 상태");
    expect(text).not.toContain("## 지속 지시");
    expect(text).not.toContain("stored-instruction-marker");
    expect(standingInstructions).toEqual(["stored-instruction-marker"]);
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

  it("titles the standing-instruction section 지속 지시", () => {
    const { text } = itemText({
      material: makeMaterial(),
      cards: makeCards(),
      standingInstructions: ["답은 짧게 한다"],
      ownSessionId,
    });

    expect(text).toContain("## 지속 지시");
    expect(text).toContain("답은 짧게 한다");
    expect(text).not.toContain("지속 지침");
  });
});
