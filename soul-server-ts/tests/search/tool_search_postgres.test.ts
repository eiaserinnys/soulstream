import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionDB } from "../../src/db/session_db.js";
import { searchSessionEvents } from "../../src/search/session_search.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { configureTestSessionDataHost } from "../helpers/session_data_test_host.js";
import { appendTestEvent } from "../helpers/append_test_event.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("tool event PostgreSQL search integration", () => {
  let harness: FullSchemaPostgresHarness | undefined;
  let db: SessionDB;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    db = new SessionDB();
    configureTestSessionDataHost(db, harness.sql);
    await harness.sql`
      INSERT INTO sessions (
        session_id, display_name, status, session_type, agent_id,
        created_at, updated_at
      ) VALUES (
        'tool-search-session', 'Tool Search', 'completed', 'llm',
        'roselin_codex', NOW(), NOW()
      )
    `;
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("persists synthetic tool events and finds both through searchSessionEvents", async () => {
    await appendTestEvent(harness!.sql, {
      sessionId: "tool-search-session",
      eventType: "tool_start",
      payload: JSON.stringify({
        type: "tool_start",
        tool_name: "mcp/atom/search_cards",
        tool_input: { query: "침몰선 설계", path: "project/lore" },
      }),
      searchableText: "mcp/atom/search_cards 침몰선 설계 project/lore",
      createdAt: new Date(),
    });
    await appendTestEvent(harness!.sql, {
      sessionId: "tool-search-session",
      eventType: "tool_result",
      payload: JSON.stringify({
        type: "tool_result",
        tool_name: "mcp/atom/search_cards",
        result: "침몰선 설계 카드를 찾았습니다 foundmarker",
        is_error: false,
      }),
      searchableText: "mcp/atom/search_cards 침몰선 설계 카드를 찾았습니다 foundmarker",
      createdAt: new Date(),
    });

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
