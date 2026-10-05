import { describe, expect, it, vi } from "vitest";

import { createPersistentContextService } from "../src/persistent-context/persistent_context_service.js";
import type { PersistentContextCandidateRepositories } from "../src/persistent-context/persistent_context_candidates.js";
import type { CogitoSearchProvider } from "../src/cogito/cogito_routes.js";
import { SessionStoryReadRepository } from "../src/control_plane/repositories/session_story_read_repository.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { createPersistentContextCandidateRepositories } from "../src/persistent-context/persistent_context_candidates.js";
import { createLiveCogitoSearchProvider } from "../src/runtime/live_cogito_search_provider.js";
import type { LiveSearchDbConnectionFactory, LiveSearchSql } from "../src/runtime/live_db_sql.js";
import { createFullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

function createRepositories(
  raw: Awaited<ReturnType<PersistentContextCandidateRepositories["readSessionAndBoundedCandidates"]>>,
  withSummary = true,
): PersistentContextCandidateRepositories {
  return {
    readSessionAndBoundedCandidates: vi.fn(async () => raw),
    storyReads: {
      countTurnSummaries: vi.fn(async () => ({ totalCount: withSummary ? 1 : 0, digestedCount: 0, undigestedCount: withSummary ? 1 : 0 })),
      loadTurnSummaryRange: vi.fn(async () => withSummary ? [
        { eventId: 2, turnNumber: 1, content: "요청 흐름을 정리했습니다.", turnStartEventId: null, finalResponseEventId: null, createdAt: new Date() },
      ] : []),
    } as unknown as PersistentContextCandidateRepositories["storyReads"],
  };
}

describe("persistent context evaluation", () => {
  it("deduplicates search and recent sessions and stores stable score order", async () => {
    const repositories = createRepositories({
      sessionIsPersistent: true,
      inputEventId: 10,
      allowedFolderIds: ["visible"],
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
      top_k: 4,
      allowedFolderIds: ["visible"],
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
      allowedFolderIds: [],
      turnSummaries: [],
      cards: [],
      recentCompletedSessions: [],
    }, false);
    const fetchImpl = vi.fn();
    const service = createPersistentContextService({
      candidates: repositories,
      searchProvider: {
        search: async () => ({ search_status: { session_sources: { metadata: { status: "complete" } } }, session_results: [] }),
      } as unknown as CogitoSearchProvider,
      typesafeApiKey: "test-key",
      logMissingInput: vi.fn(),
      fetchImpl,
    });
    await expect(service.evaluatePersistentCandidates({
      sessionId: "current", inputId: "input-10", request: "현재 요청",
      deadlineAt: Date.now() + 2_000, signal: new AbortController().signal,
    })).resolves.toEqual({ observation: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses real lexical SQL scoped to visible folders and removes the current session", async () => {
    const db = await createFullSchemaPostgresHarness();
    try {
      await db.sql`
        INSERT INTO folders (id, name, archived, settings) VALUES
          ('jev-visible', 'Visible', false, '{}'),
          ('jev-hidden', 'Hidden', false, '{"excludeFromFeed":true}')
      `;
      await db.sql`
        INSERT INTO sessions (session_id, folder_id, display_name, prompt, status, session_type, metadata)
        VALUES ('jev-current', 'jev-visible', 'Jev lexical access phrase', 'current', 'running', 'claude',
          '[{"type":"persistent_session","value":{"enabled":true}}]'::jsonb)
      `;
      await db.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES ('jev-current', 9001, 'user_message', '{"input_id":"input-current"}', 'request')
      `;
      await db.sql`
        INSERT INTO sessions (session_id, folder_id, display_name, prompt, status, session_type)
        SELECT 'jev-visible-' || n, 'jev-visible', 'Jev lexical access phrase ' || n,
          'lexical request ' || n, 'completed', 'claude'
        FROM generate_series(1, 25) AS n
      `;
      await db.sql`
        INSERT INTO sessions (session_id, folder_id, display_name, prompt, status, session_type)
        VALUES ('jev-hidden-session', 'jev-hidden', 'Jev lexical access phrase hidden', 'hidden lexical request', 'completed', 'claude')
      `;
      const liveSql = db.sql as unknown as LiveSearchSql;
      const searchConnectionFactory: LiveSearchDbConnectionFactory = {
        open: async () => ({ sql: liveSql, close: async () => {} }),
      };
      const storyReads = new SessionStoryReadRepository(db.sql as unknown as SqlClient, searchConnectionFactory);
      const candidates = createPersistentContextCandidateRepositories({ searchDbConnectionFactory: searchConnectionFactory, storyReads });
      const searchProvider = createLiveCogitoSearchProvider({ searchDbConnectionFactory: searchConnectionFactory });
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { state: { candidates: Array<{ key: string }> } };
        return new Response(JSON.stringify({ answers: Object.fromEntries(body.state.candidates.map(({ key }) => [key, { score: 2 }])) }), { status: 200 });
      });
      const service = createPersistentContextService({
        candidates,
        searchProvider,
        typesafeApiKey: "test-key",
        logMissingInput: vi.fn(),
        fetchImpl,
      });

      const result = await service.evaluatePersistentCandidates({
        sessionId: "jev-current",
        inputId: "input-current",
        request: "Jev lexical access phrase",
        deadlineAt: Date.now() + 8_000,
        signal: new AbortController().signal,
      });
      const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { state: { candidates: Array<{ key: string; text: string }> } };

      expect(result.observation?.candidate_counts).toMatchObject({ search_sessions: 15 });
      expect(sent.state.candidates).toHaveLength(15);
      expect(sent.state.candidates.every(({ text }) => !text.includes("hidden"))).toBe(true);
      expect(sent.state.candidates.some(({ text }) => text.includes("Jev lexical access phrase — Jev lexical access phrase"))).toBe(false);
      expect(result.observation?.selected.every((candidate) => candidate.kind !== "session" || candidate.session_id !== "jev-current")).toBe(true);
    } finally {
      await db.cleanup();
    }
  }, 30_000);
});
