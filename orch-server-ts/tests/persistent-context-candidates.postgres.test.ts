import { describe, expect, it } from "vitest";

import { createPersistentContextCandidateRepositories } from "../src/persistent-context/persistent_context_candidates.js";
import type { LiveSearchDbConnectionFactory, LiveSearchSql } from "../src/runtime/live_db_sql.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionStoryReadRepository } from "../src/control_plane/repositories/session_story_read_repository.js";
import { createFullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("persistent context candidates in PostgreSQL", () => {
  it("bounds visible cards and completed sessions and reads only pre-input summaries", async () => {
    const db = await createFullSchemaPostgresHarness();
    try {
      await db.sql`
        INSERT INTO folders (id, name, archived, settings) VALUES
          ('jev-visible', 'Visible', false, '{}'),
          ('jev-hidden', 'Hidden', false, '{"excludeFromFeed": true}'),
          ('jev-archived', 'Archived', true, '{}')
      `;
      await db.sql`
        INSERT INTO sessions (session_id, folder_id, session_type, status, display_name, metadata, updated_at)
        VALUES
          ('jev-current', 'jev-visible', 'claude', 'running', 'Current',
            '[{"type":"persistent_session","value":{"enabled":true}}]'::jsonb, NOW()),
          ('jev-hidden-session', 'jev-hidden', 'claude', 'completed', 'Hidden', '[]'::jsonb, NOW()),
          ('jev-archived-session', 'jev-archived', 'claude', 'completed', 'Archived', '[]'::jsonb, NOW()),
          ('jev-llm-session', 'jev-visible', 'llm', 'completed', 'Internal', '[]'::jsonb, NOW())
      `;
      await db.sql`
        INSERT INTO sessions (session_id, folder_id, session_type, status, display_name, updated_at)
        SELECT 'jev-completed-' || n, 'jev-visible', 'claude', 'completed', 'Completed ' || n,
          TIMESTAMPTZ '2026-01-01T00:00:00Z' + n * INTERVAL '1 day'
        FROM generate_series(1, 7) AS n
      `;
      await db.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
        VALUES
          ('jev-current', 1, 'turn_summary', '{"content":"이전 요약 하나"}', NULL, NOW()),
          ('jev-current', 2, 'turn_summary', '{"content":"이전 요약 둘"}', NULL, NOW()),
          ('jev-current', 3, 'user_message', '{"input_id":"input-current"}', '현재 요청', NOW()),
          ('jev-current', 4, 'turn_summary', '{"content":"입력 뒤 요약"}', NULL, NOW()),
          ('jev-completed-1', 1, 'user_message', '{"text":"완료 세션 요청"}', '완료 세션 요청', TIMESTAMPTZ '2026-01-01T00:00:00Z')
      `;
      await db.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
        SELECT 'jev-completed-' || n, 2, 'complete', '{}', NULL,
          TIMESTAMPTZ '2026-01-01T00:00:00Z' + n * INTERVAL '1 day'
        FROM generate_series(1, 7) AS n
      `;
      await db.sql`
        UPDATE sessions SET termination_event_id = 2 WHERE session_id LIKE 'jev-completed-%'
      `;
      await db.sql`
        INSERT INTO cards (id, folder_id, position_key, title, request, brief, status, assignee_kind, assignee_session_id)
        SELECT 'jev-card-' || n, 'jev-visible', lpad(n::text, 4, '0'), 'Card ' || n, 'Request ' || n, '',
          CASE WHEN n = 22 THEN 'done' ELSE 'running' END,
          CASE WHEN n = 21 THEN 'session' END,
          CASE WHEN n = 21 THEN 'jev-current' END
        FROM generate_series(1, 22) AS n
      `;
      await db.sql`
        INSERT INTO cards (id, folder_id, position_key, title, status)
        VALUES
          ('jev-card-hidden', 'jev-hidden', 'h1', 'Hidden card', 'running'),
          ('jev-card-archived', 'jev-archived', 'a1', 'Archived card', 'running')
      `;

      const liveSql = db.sql as unknown as LiveSearchSql;
      const searchConnectionFactory: LiveSearchDbConnectionFactory = {
        open: async () => ({ sql: liveSql, close: async () => {} }),
      };
      const storyReads = new SessionStoryReadRepository(
        db.sql as unknown as SqlClient,
        searchConnectionFactory,
      );
      const repositories = createPersistentContextCandidateRepositories({
        searchDbConnectionFactory: searchConnectionFactory,
        storyReads,
      });
      const signal = new AbortController().signal;
      const raw = await repositories.readSessionAndBoundedCandidates("jev-current", "input-current", signal);
      const counts = await storyReads.countTurnSummaries("jev-current", { beforeEventId: raw.inputEventId!, signal });
      const summaries = await storyReads.loadTurnSummaryRange(
        "jev-current", 1, null, 40, { beforeEventId: raw.inputEventId!, signal },
      );

      expect(raw).toMatchObject({ sessionIsPersistent: true, inputEventId: 3 });
      expect(raw.cards).toHaveLength(20);
      expect(raw.cards.some((card) => card.id === "jev-card-21")).toBe(true);
      expect(raw.cards.some((card) => card.id === "jev-card-22")).toBe(false);
      expect(raw.cards.some((card) => card.id === "jev-card-hidden" || card.id === "jev-card-archived")).toBe(false);
      expect(raw.recentCompletedSessions).toHaveLength(5);
      expect(raw.recentCompletedSessions[0]?.sessionId).toBe("jev-completed-7");
      expect(raw.recentCompletedSessions.some((session) =>
        ["jev-current", "jev-hidden-session", "jev-archived-session", "jev-llm-session"].includes(session.sessionId),
      )).toBe(false);
      expect(counts.totalCount).toBe(2);
      expect(summaries.map((summary) => summary.content)).toEqual(["이전 요약 하나", "이전 요약 둘"]);
    } finally {
      await db.cleanup();
    }
  });
});
