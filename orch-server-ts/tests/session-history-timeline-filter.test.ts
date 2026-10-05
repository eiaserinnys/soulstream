import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createLiveDbCatalogRepository,
  parseOrchServerConfig,
  type SessionHistoryProvider,
  type LivePostgresSql,
} from "../src/index.js";
import { createFullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { isSessionTimelineEventType } from "../src/session/session_history_service.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createHarness() {
  const readTimeline = vi.fn(async () => [[], null] as [unknown[], string | null]);
  const provider = { readTimeline } as unknown as SessionHistoryProvider;
  const app = createApp({
    config,
    sessionHistoryRoutes: { provider, closeAfterHistorySync: true },
  });
  return { app, readTimeline };
}

describe("session timeline event_types filter", () => {
  it("uses the shared timeline event inventory and excludes the schema-outside system event", () => {
    expect(isSessionTimelineEventType("system_message")).toBe(true);
    expect(isSessionTimelineEventType("generation_started")).toBe(true);
    expect(isSessionTimelineEventType("system")).toBe(false);
  });

  it("passes an additive event_types subset to timeline reads", async () => {
    const { app, readTimeline } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=user_message,assistant_message",
    });

    expect(response.statusCode).toBe(200);
    expect(readTimeline).toHaveBeenCalledWith(
      "sess-1",
      null,
      50,
      ["user_message", "assistant_message"],
    );
    await app.close();
  });

  it("returns the stored id and payload for an explicit generation_started timeline filter", async () => {
    const db = await createFullSchemaPostgresHarness();
    try {
      const payload = { generation: 2, reason: "user_requested", previous_generation: 1, current_generation: 2, checkpoint: {}, timestamp: "2026-10-05T00:00:00Z" };
      await db.sql`INSERT INTO sessions (session_id) VALUES ('sess-1')`;
      await db.sql`INSERT INTO events (session_id, id, event_type, payload) VALUES ('sess-1', 77, 'generation_started', ${db.sql.json(payload)})`;
      const provider = createLiveDbCatalogRepository({ sql: db.sql as unknown as LivePostgresSql }).sessionHistoryProvider;
      const app = createApp({ config, sessionHistoryRoutes: { provider, closeAfterHistorySync: true } });
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/sess-1/timeline?event_types=generation_started",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ messages: [expect.objectContaining({ id: 77, event_type: "generation_started", payload })] });
      await app.close();
    } finally {
      await db.cleanup();
    }
  });

  it("rejects empty and unknown event_types before provider access", async () => {
    const { app, readTimeline } = createHarness();

    for (const query of ["event_types=", "event_types=user_message,future_event"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/sess-1/timeline?${query}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_QUERY", details: { field: "event_types" } },
      });
    }
    expect(readTimeline).not.toHaveBeenCalled();
    await app.close();
  });
});
