import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";

import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createLiveSessionHistoryProvider } from "../src/runtime/live_session_history_provider.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const describePostgres = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

describePostgres("session output attachment history PostgreSQL projection", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`ALTER TABLE events ADD COLUMN parent_event_id INTEGER`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id)
      VALUES
        ('timeline-attachments', 'node-a'),
        ('timeline-attachments-other', 'node-b'),
        ('timeline-attachments-legacy', 'node-legacy')
    `;
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  it("keeps only attachment-bearing complete events, preserves cursors and legacy fields", async () => {
    const sessionId = "timeline-attachments";
    const timestamp = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`);
    await insertEvent(sessionId, 1, "assistant_message", { content: "assistant" }, timestamp(1));
    await insertEvent(sessionId, 2, "complete", { attachment_ids: ["asset-2"] }, timestamp(2));
    await insertEvent(sessionId, 3, "complete", { attachments: ["/legacy/three.txt"] }, timestamp(3));
    await insertEvent(sessionId, 4, "complete", {
      attachment_paths: ["/legacy/four.txt"],
      attachment_count: 1,
      node_id: "node-a",
    }, timestamp(4));
    await insertEvent(sessionId, 5, "complete", { attachment_ids: "asset-scalar" }, timestamp(5));
    await insertEvent(sessionId, 6, "complete", { attachments: { path: "/legacy/object.txt" } }, timestamp(6));
    await insertEvent(sessionId, 7, "complete", { attachment_paths: [] }, timestamp(7));
    await insertEvent("timeline-attachments-other", 2, "complete", {
      attachment_ids: ["asset-other"],
    }, timestamp(2));
    await insertEvent("timeline-attachments-legacy", 9, "complete", {
      result: "legacy output",
      attachment_ids: ["asset-legacy"],
      attachments: ["/legacy/one.txt"],
      attachment_paths: ["/legacy/two.txt"],
      attachment_count: 2,
      node_id: "node-legacy",
    }, timestamp(9));

    const sqlResolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const provider = createLiveSessionHistoryProvider({ sqlResolver });
    const [defaultMessages] = await provider.readTimeline(sessionId, null, 20);
    expect(eventIds(defaultMessages)).toEqual([4, 3, 2, 1]);
    expect(defaultMessages.slice(0, 3).map((message) => messagePayload(message))).toEqual([
      expect.objectContaining({ attachment_paths: ["/legacy/four.txt"], node_id: "node-a" }),
      expect.objectContaining({ attachments: ["/legacy/three.txt"] }),
      expect.objectContaining({ attachment_ids: ["asset-2"] }),
    ]);

    const [assistantMessages] = await provider.readTimeline(
      sessionId,
      null,
      20,
      ["assistant_message"],
    );
    expect(eventIds(assistantMessages)).toEqual([4, 3, 2, 1]);
    const [toolMessages] = await provider.readTimeline(sessionId, null, 20, ["tool_result"]);
    expect(toolMessages).toEqual([]);

    const [firstPage, nextCursor] = await provider.readTimeline(sessionId, null, 2);
    expect(eventIds(firstPage)).toEqual([4, 3]);
    expect(nextCursor).toBe(`${timestamp(3).toISOString()},3`);
    const [timestampCursor] = await provider.readTimeline(
      sessionId,
      timestamp(4).toISOString(),
      20,
    );
    const [timestampIdCursor] = await provider.readTimeline(
      sessionId,
      `${timestamp(4).toISOString()},4`,
      20,
    );
    expect(eventIds(timestampCursor)).toEqual([3, 2, 1]);
    expect(eventIds(timestampIdCursor)).toEqual([3, 2, 1]);

    const reopenedProvider = createLiveSessionHistoryProvider({ sqlResolver });
    const [reopenedMessages] = await reopenedProvider.readTimeline(sessionId, null, 20);
    expect(reopenedMessages.map(messagePayload)).toEqual(defaultMessages.map(messagePayload));
    const [otherSessionMessages] = await provider.readTimeline(
      "timeline-attachments-other",
      null,
      20,
    );
    expect(eventIds(otherSessionMessages)).toEqual([2]);
    expect(otherSessionMessages[0]).toMatchObject({
      payload: { attachment_ids: ["asset-other"] },
    });

    const [legacyMessages] = await provider.readTimeline("timeline-attachments-legacy", null, 20);
    expect(legacyMessages).toEqual([
      expect.objectContaining({
        id: 9,
        event_type: "assistant_message",
        payload: {
          type: "assistant_message",
          content: "legacy output",
          attachment_ids: ["asset-legacy"],
          attachments: ["/legacy/one.txt"],
          attachment_paths: ["/legacy/two.txt"],
          attachment_count: 2,
          node_id: "node-legacy",
        },
      }),
    ]);

    const explain = await harness.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      return tx<{ "QUERY PLAN": unknown }[]>`
        EXPLAIN (FORMAT JSON)
        SELECT id, parent_event_id, event_type, payload, created_at
        FROM events
        WHERE session_id = ${sessionId}
          AND (
            event_type = ANY(${["assistant_message"]}::text[])
            OR (
              event_type = 'complete'
              AND (
                (jsonb_typeof(payload->'attachment_ids') = 'array' AND payload->'attachment_ids' <> '[]'::jsonb)
                OR (jsonb_typeof(payload->'attachments') = 'array' AND payload->'attachments' <> '[]'::jsonb)
                OR (jsonb_typeof(payload->'attachment_paths') = 'array' AND payload->'attachment_paths' <> '[]'::jsonb)
              )
            )
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 21
      `;
    });
    const planText = JSON.stringify(explain[0]?.["QUERY PLAN"]);
    expect(planText).toMatch(/"Index Name":"events_[^"]+"/);
    expect(planText).toMatch(/Index Cond.*session_id/);

    async function insertEvent(
      eventSessionId: string,
      id: number,
      eventType: string,
      payload: postgres.JSONValue,
      createdAt: Date,
    ): Promise<void> {
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, created_at)
        VALUES (
          ${eventSessionId}, ${id}, ${eventType}, ${harness.sql.json(payload)}::jsonb, ${createdAt}
        )
      `;
    }

    function eventIds(messages: unknown[]): number[] {
      return messages.map((message) => Number((message as { id: number }).id));
    }

    function messagePayload(message: unknown): unknown {
      return (message as { payload: unknown }).payload;
    }
  }, 60_000);
});
