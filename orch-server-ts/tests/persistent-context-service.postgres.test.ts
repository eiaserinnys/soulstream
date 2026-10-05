import { describe, expect, it, vi } from "vitest";

import { createPersistentContextService } from "../src/persistent-context/persistent_context_service.js";
import { createPersistentContextCandidateRepositories } from "../src/persistent-context/persistent_context_candidates.js";
import { SessionStoryReadRepository } from "../src/control_plane/repositories/session_story_read_repository.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { createLiveCogitoSearchProvider } from "../src/runtime/live_cogito_search_provider.js";
import type { LiveSearchDbConnectionFactory, LiveSearchSql } from "../src/runtime/live_db_sql.js";
import type { CogitoSearchProvider } from "../src/cogito/cogito_routes.js";
import { createFullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("persistent context lexical SQL in PostgreSQL", () => {
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
        logNullReason: vi.fn(),
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
