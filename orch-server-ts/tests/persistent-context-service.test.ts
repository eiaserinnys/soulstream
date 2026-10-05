import { describe, expect, it, vi } from "vitest";

import { createPersistentContextService } from "../src/persistent-context/persistent_context_service.js";
import type { PersistentContextCandidateRepositories } from "../src/persistent-context/persistent_context_candidates.js";
import type { CogitoSearchProvider } from "../src/cogito/cogito_routes.js";

function createRepositories(
  raw: Awaited<ReturnType<PersistentContextCandidateRepositories["readSessionAndBoundedCandidates"]>>,
): PersistentContextCandidateRepositories {
  return {
    readSessionAndBoundedCandidates: vi.fn(async () => raw),
    storyReads: {
      countTurnSummaries: vi.fn(async () => ({ totalCount: 1, digestedCount: 0, undigestedCount: 1 })),
      loadTurnSummaryRange: vi.fn(async () => [
        { eventId: 2, turnNumber: 1, content: "요청 흐름을 정리했습니다.", turnStartEventId: null, finalResponseEventId: null, createdAt: new Date() },
      ]),
    } as unknown as PersistentContextCandidateRepositories["storyReads"],
  };
}

describe("persistent context evaluation", () => {
  it("deduplicates search and recent sessions and stores stable score order", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      turnSummaries: [],
      cards: [{ id: "card-1", number: 5, title: "열린 작업", request: "기능 요청", brief: "진행 중", }],
      recentCompletedSessions: [
        { sessionId: "session-overlap", title: "겹친 세션", firstRequest: "완료 요청" },
        { sessionId: "session-recent", title: "최근 완료", firstRequest: "정리 작업" },
      ],
    });
    const searchProvider = {
      search: vi.fn(async () => ({
        search_status: { session_sources: { metadata: { status: "complete" } } },
        session_results: [
          { session_id: "session-overlap", title: "겹친 세션", excerpt: "같은 세션" },
          { session_id: "session-search", title: "검색 결과", excerpt: "검색 후보" },
          { session_id: "current", title: "현재 세션", excerpt: "자기 세션은 제외" },
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
      top_k: 15,
      include_session_results: true,
      session_search_mode: "lexical",
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

  it("returns null without calling Jev when no source has a candidate", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      turnSummaries: [],
      cards: [],
      recentCompletedSessions: [],
    });
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: {
        search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }),
      } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      fetchImpl: vi.fn(),
    });
    await expect(service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "현재 요청",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    })).resolves.toEqual({ observation: null });
  });
});
