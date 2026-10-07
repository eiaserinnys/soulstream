import { afterEach, describe, expect, it } from "vitest";

import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";
import { SessionReadRepository } from "../src/control_plane/repositories/session_read_repository.js";
import { SessionStoryReadRepository } from "../src/control_plane/repositories/session_story_read_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const SINCE = "2026-10-06T00:00:00.000Z";
const UNTIL = "2026-10-07T00:00:00.000Z";
const PERIOD = { since: SINCE, until: UNTIL };

describe("session activity period repositories", () => {
  let harness: PagePostgresHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("lists event-active sessions by ID, pages without overlap, and filters events and summaries by UTC boundaries", async () => {
    harness = await createPagePostgresHarness();
    const { sql } = harness;
    await sql.unsafe(`
      ALTER TABLE sessions
        ADD COLUMN away_summary TEXT,
        ADD COLUMN last_read_event_id INTEGER,
        ADD COLUMN model_preset TEXT,
        ADD COLUMN model TEXT;
      CREATE OR REPLACE FUNCTION event_read(
        p_session_id TEXT, p_after_id INTEGER, p_limit INTEGER, p_event_types TEXT[]
      ) RETURNS TABLE(
        id INTEGER, session_id TEXT, event_type TEXT, payload JSONB,
        searchable_text TEXT, created_at TIMESTAMPTZ
      ) LANGUAGE sql STABLE AS $$
        SELECT e.id, e.session_id, e.event_type, e.payload, e.searchable_text, e.created_at
        FROM events e
        WHERE e.session_id = p_session_id AND e.id > p_after_id
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
        ORDER BY e.id LIMIT p_limit
      $$;
      CREATE OR REPLACE FUNCTION event_count(p_session_id TEXT)
      RETURNS INTEGER LANGUAGE sql STABLE AS $$
        SELECT COUNT(*)::INTEGER FROM events WHERE session_id = p_session_id
      $$;
      CREATE TABLE session_digests (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
        narrative_through_event_id INTEGER NOT NULL DEFAULT 0
      );
    `);

    for (const session of [
      { id: "a-tool-only", node: "eiaserinnys" },
      { id: "b-node-two", node: "eias-linegames" },
      { id: "m-no-summary", node: "eias-linegames-wsl" },
      { id: "n-until-only", node: "eiaserinnys" },
      { id: "z-old", node: "eiaserinnys" },
    ]) {
      await sql`
        INSERT INTO sessions (session_id, display_name, node_id, status, session_type)
        VALUES (${session.id}, ${session.id}, ${session.node}, 'completed', 'agent')
      `;
    }
    await sql`INSERT INTO session_digests (session_id, narrative_through_event_id) VALUES ('b-node-two', 1)`;

    const insertEvent = async (
      sessionId: string,
      id: number,
      eventType: string,
      createdAt: string,
      payload: Record<string, string | number | null> = {},
    ) => sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
      VALUES (${sessionId}, ${id}, ${eventType}, ${sql.json(payload)}, '', ${new Date(createdAt)})
    `;

    await insertEvent("a-tool-only", 1, "tool_start", "2026-10-06T08:00:00Z");
    await insertEvent("b-node-two", 1, "turn_summary", "2026-10-05T23:59:59.999Z", {
      content: "이전 턴", turn_start_event_id: 1, final_response_event_id: 1,
    });
    await insertEvent("b-node-two", 2, "user_message", "2026-10-06T00:00:00Z");
    await insertEvent("b-node-two", 3, "assistant_message", "2026-10-06T12:00:00Z");
    await insertEvent("b-node-two", 4, "assistant_message", "2026-10-07T00:00:00Z");
    await insertEvent("b-node-two", 5, "turn_summary", "2026-10-06T12:30:00Z", {
      content: "첫 턴", turn_start_event_id: 1, final_response_event_id: 1,
    });
    await insertEvent("b-node-two", 6, "assistant_message", "2026-10-06T13:00:00Z");
    await insertEvent("b-node-two", 7, "turn_summary", "2026-10-08T00:00:00Z", {
      content: "늦게 저장된 둘째 턴", turn_start_event_id: 2, final_response_event_id: 3,
    });
    await insertEvent("b-node-two", 8, "tool_result", "2026-10-07T00:00:00Z");
    await insertEvent("b-node-two", 9, "turn_summary", "2026-10-07T00:00:00Z", {
      content: "경계 밖 턴", turn_start_event_id: 3, final_response_event_id: 8,
    });
    await insertEvent("m-no-summary", 1, "tool_result", "2026-10-06T09:00:00Z");
    await insertEvent("n-until-only", 1, "assistant_message", "2026-10-07T00:00:00Z");
    await insertEvent("z-old", 1, "assistant_message", "2026-10-05T12:00:00Z");

    const sessions = new SessionReadRepository(sql as never);
    const firstPage = await sessions.listSessionsSummary({ limit: 2, offset: 0, period: PERIOD });
    const secondPage = await sessions.listSessionsSummary({ limit: 2, offset: 2, period: PERIOD });
    expect.soft(firstPage.sessions.map((row) => row.session_id)).toEqual(["a-tool-only", "b-node-two"]);
    expect.soft(secondPage.sessions.map((row) => row.session_id)).toEqual(["m-no-summary"]);
    expect.soft(firstPage.total).toBe(3);
    expect.soft(secondPage.total).toBe(3);
    expect.soft(new Set([...firstPage.sessions, ...secondPage.sessions].map((row) => row.node_id)).size).toBe(3);

    const events = new EventReadRepository(sql as never);
    const firstEvents = await events.readEvents("b-node-two", 0, 1, undefined, PERIOD);
    const nextEvents = await events.readEvents("b-node-two", firstEvents.at(-1)?.id ?? 0, 1, undefined, PERIOD);
    expect.soft(firstEvents.map((event) => event.id)).toEqual([2]);
    expect.soft(nextEvents.map((event) => event.id)).toEqual([3]);
    expect(await events.countEvents("b-node-two")).toBe(9);

    const stories = new SessionStoryReadRepository(sql as never);
    const summaries = await stories.loadTurnSummaryRange("b-node-two", 1, null, 10, { period: PERIOD } as never);
    expect.soft(summaries.map((summary) => summary.turnNumber)).toEqual([2, 3]);
    expect.soft(summaries.map((summary) => summary.content)).toEqual(["첫 턴", "늦게 저장된 둘째 턴"]);
    await expect(stories.loadTurnSummaryRange("m-no-summary", 1, null, 10, { period: PERIOD } as never))
      .resolves.toEqual([]);
  });
});
