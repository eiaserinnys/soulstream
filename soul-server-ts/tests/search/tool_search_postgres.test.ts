import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventPersistence } from "../../src/db/event_persistence.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { searchSessionEvents } from "../../src/search/session_search.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("tool event PostgreSQL search integration", () => {
  let harness: FullSchemaPostgresHarness | undefined;
  let db: SessionDB;
  let persistence: EventPersistence;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    db = new SessionDB(harness.sql);
    await harness.sql`
      INSERT INTO sessions (
        session_id, display_name, status, session_type, agent_id,
        created_at, updated_at
      ) VALUES (
        'tool-search-session', 'Tool Search', 'completed', 'llm',
        'roselin_codex', NOW(), NOW()
      )
    `;
    persistence = new EventPersistence(
      db,
      {} as SessionBroadcaster,
      pino({ level: "silent" }),
    );
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("persists synthetic tool events and finds both through searchSessionEvents", async () => {
    await persistence.persistEvent(
      "tool-search-session",
      {
        type: "tool_start",
        tool_name: "mcp/atom/search_cards",
        tool_input: { query: "침몰선 설계", path: "project/lore" },
      } as unknown as SSEEventPayload,
    );
    await persistence.persistEvent(
      "tool-search-session",
      {
        type: "tool_result",
        tool_name: "mcp/atom/search_cards",
        result: "침몰선 설계 카드를 찾았습니다 foundmarker",
        is_error: false,
      } as unknown as SSEEventPayload,
    );

    const starts = await searchSessionEvents(db, {
      query: "project/lore",
      eventTypes: ["tool_start", "tool_result"],
      limit: 10,
    });
    const results = await searchSessionEvents(db, {
      query: "foundmarker",
      eventTypes: ["tool_start", "tool_result"],
      limit: 10,
    });

    expect(starts).toEqual([
      expect.objectContaining({
        session_id: "tool-search-session",
        event_type: "tool_start",
      }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        session_id: "tool-search-session",
        event_type: "tool_result",
      }),
    ]);
  });
});
