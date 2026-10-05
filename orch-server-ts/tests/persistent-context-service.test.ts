import { describe, expect, it, vi } from "vitest";

import { createPersistentContextService } from "../src/persistent-context/persistent_context_service.js";
import type { PersistentContextCandidateRepositories } from "../src/persistent-context/persistent_context_candidates.js";
import type { CogitoSearchProvider } from "../src/cogito/cogito_routes.js";
import { isPersistentJevCandidatesDebugEvent } from "@soulstream/wire-schema/persistent-jev-candidates";

function createRepositories(
  raw: Awaited<ReturnType<PersistentContextCandidateRepositories["readSessionAndBoundedCandidates"]>>,
  withSummary = true,
  summaryContent = "요청 흐름을 정리했습니다.",
): PersistentContextCandidateRepositories {
  return {
    readSessionAndBoundedCandidates: vi.fn(async () => raw),
    storyReads: {
      countTurnSummaries: vi.fn(async () => ({ totalCount: withSummary ? 1 : 0, digestedCount: 0, undigestedCount: withSummary ? 1 : 0 })),
      loadTurnSummaryRange: vi.fn(async () => withSummary ? [
        { eventId: 2, turnNumber: 1, content: summaryContent, turnStartEventId: null, finalResponseEventId: null, createdAt: new Date() },
      ] : []),
    } as unknown as PersistentContextCandidateRepositories["storyReads"],
  };
}

describe("persistent context evaluation", () => {
  it("normalizes line breaks and UUID tokens across candidate kinds before evaluation and recording", async () => {
    const sample = "[회의 노트 / 주간 정리]\n\n## 진행 항목\n- 카드: 11111111-2222-4333-8444-555555555555 「도서 목록 동기화」(폴더 66666666-7777-4888-8999-aaaaaaaaaaaa). 저장된 설명은 항목을 짧게 정리합니다.";
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: ["visible"],
      turnSummaries: [],
      cards: [{
        id: "card-1", number: 8, title: "카드 제목", request: "첫 줄\t7349e4a2-d679-4702-83b4-fe7c3b1f2511", brief: "둘째 줄",
      }],
      recentCompletedSessions: [{ sessionId: "session-1", title: "이전 작업", lastAssistantText: sample }],
    }, true, "요약\n7349e4a2-d679-4702-83b4-fe7c3b1f2511\t완료");
    let sentTexts: string[] = [];
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: { search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }) } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { state: { candidates: Array<{ key: string; text: string }> } };
        sentTexts = body.state.candidates.map(({ text }) => text);
        return new Response(JSON.stringify({ answers: Object.fromEntries(body.state.candidates.map(({ key }) => [key, { score: 2.65 }])) }), { status: 200 });
      }),
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    });

    const lines = result.observation?.selected.map(({ line }) => line) ?? [];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n\t]/);
      expect(line).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(240);
    }
    expect(lines.join(" ")).toContain("[회의 노트 / 주간 정리] ## 진행 항목 - 카드:");
    expect(sentTexts.join(" ")).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation: result.observation,
    })).toBe(true);
  });

  it("accepts the captured decimal Jev response and rounds only the selected observation score", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: ["visible"],
      turnSummaries: [],
      cards: [],
      recentCompletedSessions: [
        { sessionId: "session-0", title: "higher score", lastAssistantText: "request 2" },
        { sessionId: "session-1", title: "lower score", lastAssistantText: "request 3" },
      ],
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { candidates: Array<{ key: string }> } };
      const capturedAnswers = [
        { type: "score", score: 0.78, confidence: 0.22, legend: { "0": "unrelated", "1": "reference", "2": "relevant", "3": "essential" }, probabilities: { "0": 0.2, "1": 0.4, "2": 0.3, "3": 0.1 } },
        { type: "score", score: 2.65, confidence: 0.65, legend: { "0": "unrelated", "1": "reference", "2": "relevant", "3": "essential" }, probabilities: { "0": 0.01, "1": 0.02, "2": 0.26, "3": 0.71 } },
        { type: "score", score: 0.04, confidence: 0.96, legend: { "0": "unrelated", "1": "reference", "2": "relevant", "3": "essential" }, probabilities: { "0": 0.96, "1": 0.03, "2": 0.01, "3": 0 } },
      ];
      return new Response(JSON.stringify({ answers: Object.fromEntries(
        body.state.candidates.map(({ key }, index) => [key, capturedAnswers[index]]),
      ) }), { status: 200 });
    });
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: {
        search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }),
      } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl,
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "current request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    });

    expect(result.observation?.selected).toEqual([
      expect.objectContaining({ kind: "session", session_id: "session-0", score: 3, raw_score: 2.65 }),
    ]);
    expect(result.observation?.top_raw_score).toBe(2.65);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation: result.observation,
    })).toBe(true);
  });

  it("deduplicates search and recent sessions and stores stable score order", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: ["visible"],
      turnSummaries: [],
      cards: [{ id: "card-1", number: 5, title: "열린 작업", request: "기능 요청", brief: "진행 중", }],
      recentCompletedSessions: [
        { sessionId: "session-overlap", title: "겹친 세션", lastAssistantText: "완료 응답" },
        { sessionId: "session-recent", title: "최근 완료", lastAssistantText: "정리 응답" },
      ],
    });
    const searchProvider = {
      search: vi.fn(async () => ({
        search_status: { session_sources: { metadata: { status: "complete" } } },
        session_results: [
          { session_id: "session-overlap", folder_id: "visible", title: "겹친 세션", excerpt: "같은 세션" },
          { session_id: "session-search", folder_id: "visible", title: "검색 결과", excerpt: "검색 후보" },
          { session_id: "current", folder_id: "visible", title: "현재 세션", excerpt: "자기 세션은 제외" },
        ],
      })),
    } as unknown as CogitoSearchProvider;
    let sent: { state: { candidates: Array<{ key: string; text: string }> }; questions: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      const scores = Object.fromEntries(sent!.state.candidates.map(({ key }, index) => [key, { score: index % 3 + 1 }]));
      return new Response(JSON.stringify({ answers: scores }), { status: 200 });
    });
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl,
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current",
      inputId: "input-10",
      request: "현재 요청",
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    });

    expect(searchProvider.search).toHaveBeenCalledWith(expect.objectContaining({
      top_k: 16,
      allowedFolderIds: ["visible"],
      search_session_id: true,
      include_session_results: true,
      session_search_mode: "expanded",
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sent?.state.candidates.map(({ key }) => key)).toEqual([
      "turn-0", "card-0", "session-0", "session-1", "session-2",
    ]);
    expect(result.observation).toMatchObject({
      input_id: "input-10",
      candidate_counts: { turn_summaries: 1, cards: 1, search_sessions: 2, recent_completed_sessions: 2 },
      model: "jev-latest",
      selected: [
        { kind: "session", session_id: "session-overlap", score: 3, sources: ["search", "recent_completed"] },
        { kind: "card", card_id: "card-1", score: 2 },
        { kind: "session", session_id: "session-recent", score: 2 },
      ],
    });
    expect(result.observation?.selected).toHaveLength(3);
  });

  it("uses expanded excerpts in provider order and filters sessions to allowed folders", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: ["visible"],
      turnSummaries: [],
      cards: [],
      recentCompletedSessions: [
        { sessionId: "overlap", title: "Expanded title", lastAssistantText: "Recent answer" },
        { sessionId: "recent-only", title: "Recent only title", lastAssistantText: "Stored completion answer" },
      ],
    }, false);
    let sentTexts: string[] = [];
    const searchProvider = {
      search: vi.fn(async () => ({
        search_status: {
          session_sources: {
            metadata: { status: "complete" },
            session_document: { status: "partial", reason: "timeout" },
            rerank: { status: "partial", reason: "timeout", latency_ms: 10 },
          },
          query_expansion: { status: "skipped", latency_ms: 0 },
        },
        session_results: [
          { session_id: "overlap", folder_id: "visible", title: "Expanded title", excerpt: "Saved expanded excerpt", first_request: "DO NOT SCORE THIS REQUEST", relevance: 0.91 },
          { session_id: "outside", folder_id: "hidden", title: "Hidden title", excerpt: "Hidden excerpt", relevance: 0.9 },
          { session_id: "folderless", title: "Folderless title", excerpt: "Folderless excerpt", relevance: 0.89 },
          { session_id: "search-only", folder_id: "visible", title: "Search only title", excerpt: "Second saved excerpt", relevance: 0.88 },
          { session_id: "current", folder_id: "visible", title: "Current", excerpt: "Self", relevance: 0.87 },
        ],
      })),
    } as unknown as CogitoSearchProvider;
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { state: { candidates: Array<{ key: string; text: string }> } };
        sentTexts = body.state.candidates.map(({ text }) => text);
        return new Response(JSON.stringify({ answers: Object.fromEntries(body.state.candidates.map(({ key }) => [key, { score: 2.5 }])) }), { status: 200 });
      }),
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "latest request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    });

    expect(searchProvider.search).toHaveBeenCalledWith(expect.objectContaining({
      top_k: 16, search_session_id: true, include_session_results: true,
      session_search_mode: "expanded", include_turn_summaries: false,
      include_highlight: false, include_story: false, allowedFolderIds: ["visible"],
      exclude_session_request_excerpt: true,
    }));
    expect(result.observation?.candidate_counts.search_sessions).toBe(2);
    expect(result.observation?.selected.flatMap((candidate) => candidate.kind === "session"
      ? [{ session_id: candidate.session_id, line: candidate.line, sources: candidate.sources }]
      : [])).toEqual([
      { session_id: "overlap", line: "Saved expanded excerpt", sources: ["search", "recent_completed"] },
      { session_id: "search-only", line: "Second saved excerpt", sources: ["search"] },
      { session_id: "recent-only", line: "Stored completion answer", sources: ["recent_completed"] },
    ]);
    expect(sentTexts.join(" ")).not.toContain("DO NOT SCORE THIS REQUEST");
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation: result.observation,
    })).toBe(true);
  });

  it("drops UUID-only turn summaries instead of scoring their turn number", async () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: ["visible"],
      turnSummaries: [],
      cards: [{ id: "card-valid", number: null, title: "Useful card", request: "Saved details", brief: "" }],
      recentCompletedSessions: [],
    }, true, uuid);
    let sent: { state: { candidates: Array<{ key: string; text: string }> } } | undefined;
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: { search: async () => ({
        search_status: { session_sources: { metadata: { status: "complete" } } },
        session_results: [],
      }) } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ answers: Object.fromEntries(
          sent!.state.candidates.map(({ key }) => [key, { score: 2.65 }]),
        ) }), { status: 200 });
      }),
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    });

    expect(sent?.state.candidates.map(({ key }) => key)).toEqual(["card-0"]);
    expect(sent?.state.candidates.some(({ text }) => text.includes("T1"))).toBe(false);
    expect(result.observation?.candidate_counts).toEqual({
      turn_summaries: 0, cards: 1, search_sessions: 0, recent_completed_sessions: 0,
    });
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation: result.observation,
    })).toBe(true);
  });

  it("propagates deadline cancellation to an in-flight expanded search", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true, inputEventId: 10, allowedFolderIds: ["visible"],
      turnSummaries: [], cards: [], recentCompletedSessions: [],
    }, false);
    const controller = new AbortController();
    const logNullReason = vi.fn();
    let searchSignal: AbortSignal | undefined;
    const searchProvider = {
      search: vi.fn((params: { signal?: AbortSignal }) => {
        searchSignal = params.signal;
        return new Promise((_, reject) => {
          params.signal?.addEventListener("abort", () => reject(params.signal?.reason), { once: true });
        });
      }),
    } as unknown as CogitoSearchProvider;
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason,
    });
    const deadlineAt = Date.now() + 30;
    const timer = setTimeout(() => controller.abort(new Error("deadline")), deadlineAt - Date.now());

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "request",
      deadlineAt, signal: controller.signal,
    });
    clearTimeout(timer);

    expect(result).toEqual({ observation: null });
    expect(searchSignal?.aborted).toBe(true);
    expect(logNullReason).toHaveBeenCalledWith("cancelled_or_deadline", "current", expect.any(Number));
  });

  it("returns null without calling Jev when no source has a candidate", async () => {
    const logNullReason = vi.fn();
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: [],
      turnSummaries: [],
      cards: [],
      recentCompletedSessions: [],
    }, true, "11111111-2222-4333-8444-555555555555");
    const fetchImpl = vi.fn();
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: {
        search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }),
      } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason,
      fetchImpl,
    });
    await expect(service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "현재 요청",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    })).resolves.toEqual({ observation: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logNullReason).toHaveBeenCalledWith("no_candidates", "current", expect.any(Number));
  });


  it("filters at 2.0, rounds selected values, and keeps raw score ordering stable on ties", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: [],
      turnSummaries: [],
      cards: [1.99, 2.0, 2.49, 2.5, 2.5].map((score, index) => ({
        id: `card-${index}`,
        number: index + 1,
        title: `card ${index}`,
        request: "request",
        brief: "brief",
      })),
      recentCompletedSessions: [],
    }, false);
    const scores = [1.99, 2.0, 2.49, 2.5, 2.5];
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: { search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }) } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { state: { candidates: Array<{ key: string }> } };
        return new Response(JSON.stringify({ answers: Object.fromEntries(
          body.state.candidates.map(({ key }, index) => [key, { score: scores[index] }]),
        ) }), { status: 200 });
      }),
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    });

    expect(result.observation?.selected).toEqual([
      expect.objectContaining({ card_id: "card-3", score: 3, raw_score: 2.5 }),
      expect.objectContaining({ card_id: "card-4", score: 3, raw_score: 2.5 }),
      expect.objectContaining({ card_id: "card-2", score: 2, raw_score: 2.49 }),
      expect.objectContaining({ card_id: "card-1", score: 2, raw_score: 2.0 }),
    ]);
    expect(result.observation?.top_raw_score).toBe(2.5);
  });

  it("records the highest raw score when no candidate meets the selection threshold", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: [],
      turnSummaries: [],
      cards: [{ id: "card-1", number: 1, title: "card", request: "request", brief: "brief" }],
      recentCompletedSessions: [],
    }, false);
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: { search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }) } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason: vi.fn(),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ answers: { "card-0": { score: 1.9 } } }), { status: 200 })),
    });

    const result = await service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    });

    expect(result.observation?.selected).toEqual([]);
    expect(result.observation?.top_raw_score).toBe(1.9);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation: result.observation,
    })).toBe(true);
  });

  it.each([
    ["missing key", undefined],
    ["string", "2"],
    ["NaN", Number.NaN],
    ["above range", 3.2],
    ["below range", -0.1],
  ])("logs jev_failed and returns null for an invalid Jev score (%s)", async (_label, score) => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: [],
      turnSummaries: [],
      cards: [{ id: "card-1", number: 1, title: "card", request: "request", brief: "brief" }],
      recentCompletedSessions: [],
    }, false);
    const logNullReason = vi.fn();
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: { search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }) } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      logNullReason,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: score === undefined ? {} : { "card-0": { score } } }),
      }) as Response),
    });

    await expect(service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "private request",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    })).resolves.toEqual({ observation: null });
    expect(logNullReason).toHaveBeenCalledTimes(1);
    expect(logNullReason).toHaveBeenCalledWith("jev_failed", "current", expect.any(Number));
  });
});
