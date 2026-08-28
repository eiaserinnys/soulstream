import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB session history provider", () => {
  it("reads viewport, last id, and raw events using the Python DB queries", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("COUNT(*)::int")) return [{ count: 1 }];
      if (text.includes("events_viewport")) {
        return [
          {
            id: 10,
            parent_event_id: null,
            event_type: "user_message",
            depth: 0,
            y_start: 1,
            y_end: 2,
            payload: "{\"text\":\"hello\"}",
          },
        ];
      }
      if (text.includes("last_event_id")) return [{ last_event_id: 12 }];
      if (text.includes("event_stream_raw")) {
        return [
          { id: 11, event_type: "text_delta", payload_text: "{\"text\":\"a\"}" },
          {
            id: 12,
            event_type: "text_end",
            payload_text: "{\"type\":\"text_end\"}",
            effect_applied: false,
          },
        ];
      }
      return [];
    });
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;

    await expect(provider.readViewport("sess-1", 1, 10)).resolves.toEqual([
      {
        id: 10,
        parent_event_id: null,
        event_type: "user_message",
        depth: 0,
        y_start: 1,
        y_end: 2,
        payload: { text: "hello" },
      },
    ]);
    await expect(provider.readLastEventId("sess-1")).resolves.toBe(12);
    const raw = [];
    for await (const event of provider.streamEventsRaw("sess-1", 10)) {
      raw.push(event);
    }
    expect(raw).toEqual([
      { eventId: 11, eventType: "text_delta", payloadText: "{\"text\":\"a\"}" },
      {
        eventId: 12,
        eventType: "text_end",
        payloadText: "{\"type\":\"text_end\"}",
        sessionEffectApplied: false,
      },
    ]);
    expect(harness.normalizedCalls()).toEqual([
      "SELECT COUNT(*)::int FROM events WHERE session_id = ? AND parent_event_id IS NULL",
      "SELECT * FROM events_viewport(?, ?, ?)",
      "SELECT COALESCE(MAX(id), 0)::int AS last_event_id FROM events WHERE session_id = ?",
      "SELECT raw_event.*, semantic_receipt.effect_applied FROM event_stream_raw(?, ?) AS raw_event LEFT JOIN LATERAL ( SELECT (receipt.effect_application->>'applied')::boolean AS effect_applied FROM event_ingress_receipts AS receipt WHERE receipt.session_id = ? AND receipt.event_id = raw_event.id AND receipt.effect_application IS NOT NULL ORDER BY receipt.created_at ASC, receipt.source_seq ASC LIMIT 1 ) AS semantic_receipt ON TRUE ORDER BY raw_event.id ASC",
    ]);
  });

  it("serializes messages, timeline tool pairs, and trace rows like Python", async () => {
    const createdAt = new Date("2026-07-09T00:00:00.000Z");
    const harness = createSqlHarness((text) => {
      if (text.includes("COUNT(*)::int")) return [{ count: 1 }];
      if (text.includes("SELECT id, parent_event_id")) {
        if (text.includes("payload->>'tool_use_id'")) {
          return [
            {
              id: 20,
              parent_event_id: null,
              event_type: "tool_start",
              payload: { tool_use_id: "tool-1", tool_name: "Bash", input: "ls -la" },
              created_at: createdAt,
            },
          ];
        }
        return [
          {
            id: 21,
            parent_event_id: 20,
            event_type: "tool_result",
            payload: "{\"tool_use_id\":\"tool-1\",\"result\":\"done\"}",
            created_at: createdAt,
          },
        ];
      }
      if (text.includes("SELECT EXISTS")) return [{ exists: true }];
      return [];
    });
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;

    await expect(provider.readMessages("sess-1", null, 1)).resolves.toEqual([
      [
        {
          id: 21,
          parent_event_id: 20,
          event_type: "tool_result",
          payload: { tool_use_id: "tool-1", result: "done" },
          created_at: "2026-07-09T00:00:00.000Z",
        },
      ],
      null,
    ]);
    await expect(provider.readTimeline("sess-1", null, 1)).resolves.toEqual([
      [
        expect.objectContaining({
          id: 21,
          event_type: "tool_result",
          payload: expect.objectContaining({
            type: "tool_result",
            tool_use_id: "tool-1",
            timeline_id: "tool:tool-1",
            status: "completed",
            result_preview: "done",
            has_trace: true,
          }),
        }),
        expect.objectContaining({
          id: 20,
          event_type: "tool_start",
          payload: expect.objectContaining({
            type: "tool_start",
            tool_use_id: "tool-1",
            timeline_id: "tool:tool-1",
            status: "completed",
            tool_input_preview: "ls -la",
            has_trace: true,
          }),
        }),
      ],
      null,
    ]);
  });

  it("returns durable turn summaries through timeline history with anchor metadata intact", async () => {
    const createdAt = new Date("2026-07-30T00:00:00.000Z");
    const harness = createSqlHarness((text, values) => {
      if (text.includes("SELECT EXISTS")) return [{ exists: true }];
      if (text.includes("event_type = ANY")) {
        expect(values).toContainEqual(expect.arrayContaining(["turn_summary"]));
        return [{
          id: 30,
          parent_event_id: 20,
          event_type: "turn_summary",
          payload: {
            type: "turn_summary",
            content: "요청을 처리하고 결과를 전달했다.",
            turn_start_event_id: 10,
            final_response_event_id: 20,
            parent_event_id: 20,
            model: "gpt-5.6-terra",
            latency_ms: 120,
            attempts: 1,
            timestamp: 123,
          },
          created_at: createdAt,
        }];
      }
      return [];
    });
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;

    await expect(provider.readTimeline("sess-1", null, 10)).resolves.toEqual([
      [{
        id: 30,
        parent_event_id: 20,
        event_type: "turn_summary",
        payload: {
          type: "turn_summary",
          content: "요청을 처리하고 결과를 전달했다.",
          turn_start_event_id: 10,
          final_response_event_id: 20,
          parent_event_id: 20,
          model: "gpt-5.6-terra",
          latency_ms: 120,
          attempts: 1,
          timestamp: 123,
        },
        created_at: createdAt.toISOString(),
      }],
      null,
    ]);
  });

  it("keeps /timeline event inventory in exact parity with Python and returns durable interventions", async () => {
    const createdAt = new Date("2026-08-12T14:37:00.902Z");
    const interventionRows = [
      {
        id: 443,
        parent_event_id: null,
        event_type: "intervention_sent",
        payload: {
          type: "intervention_sent",
          user: "dashboard",
          text: "interrupting intervention",
          timestamp: createdAt.getTime() / 1_000,
        },
        created_at: createdAt,
      },
      {
        id: 442,
        parent_event_id: null,
        event_type: "intervention_sent",
        payload: {
          type: "intervention_sent",
          user: "dashboard",
          text: "queued intervention",
          timestamp: createdAt.getTime() / 1_000 - 1,
        },
        created_at: new Date(createdAt.getTime() - 1_000),
      },
    ];
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT EXISTS")) return [{ exists: true }];
      if (text.includes("event_type = ANY")) return interventionRows;
      return [];
    });
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;
    const app = createApp({
      config: {
        environment: "test",
        databaseUrl: "postgresql://test/test",
        authBearerToken: "test-token",
      },
      sessionHistoryRoutes: {
        provider,
        closeAfterHistorySync: true,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?limit=100",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messages: interventionRows.map((row) => ({
        ...row,
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: null,
    });
    const timelineQuery = harness.calls.find((call) =>
      call.text.includes("event_type = ANY"),
    );
    expect(timelineQuery?.values[1]).toEqual(readPythonTimelineEventTypes());

    await app.close();
  });

  it("uses a requested timeline subset at SQL while preserving cursor and pairing behavior", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT EXISTS")) return [{ exists: true }];
      return [];
    });
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;

    await provider.readTimeline(
      "sess-filtered",
      "2026-08-12T00:00:00.000Z,42",
      100,
      ["user_message", "assistant_message", "tool_start", "tool_result"],
    );

    const timelineQuery = harness.calls.find((call) =>
      call.text.includes("event_type = ANY"),
    );
    expect(timelineQuery?.values).toEqual([
      "sess-filtered",
      ["user_message", "assistant_message", "tool_start", "tool_result"],
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      42,
      101,
    ]);
  });

  it("keeps legacy complete fallback only when the requested subset needs assistant output", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT EXISTS")) return [{ exists: false }];
      return [];
    });
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;

    await provider.readTimeline("sess-legacy", null, 100, ["assistant_message"]);
    await provider.readTimeline("sess-legacy", null, 100, ["user_message"]);

    const timelineQueries = harness.calls.filter((call) =>
      call.text.includes("event_type = ANY"),
    );
    expect(timelineQueries[0]?.values).toContainEqual([
      "assistant_message",
      "complete",
    ]);
    expect(timelineQueries[1]?.values).toContainEqual(["user_message"]);
  });

  it("replays DB raw events through the route filter for finalized app-server fragments", async () => {
    const harness = createSqlHarness((text) =>
      text.includes("event_stream_raw")
        ? [
            {
              id: 2,
              event_type: "text_delta",
              payload_text: JSON.stringify({
                type: "text_delta",
                tool_use_id: "item-1",
                text: "drop",
                _live_only: true,
              }),
            },
            {
              id: 3,
              event_type: "assistant_message",
              payload_text: JSON.stringify({
                type: "assistant_message",
                tool_use_id: "item-1",
                content: "final",
                _final_for_live_stream: true,
              }),
            },
          ]
        : [],
    );
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;
    const app = createApp({
      config: {
        environment: "test",
        databaseUrl: "postgresql://test/test",
        authBearerToken: "test-token",
      },
      sessionHistoryRoutes: {
        provider,
        closeAfterHistorySync: true,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events?lastEventId=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("drop");
    expect(response.body).toContain("event: assistant_message\nid: 3\n");

    await app.close();
  });
});

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}

function readPythonTimelineEventTypes(): string[] {
  const source = readFileSync(new URL(
    "../../packages/soul-common/src/soul_common/db/postgres/viewport.py",
    import.meta.url,
  ), "utf8");
  const block = source.match(
    /TIMELINE_EVENT_TYPES: tuple\[str, \.\.\.\] = \(([\s\S]*?)\n\)/,
  )?.[1];
  if (block === undefined) {
    throw new Error("Python TIMELINE_EVENT_TYPES declaration was not found");
  }
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}
