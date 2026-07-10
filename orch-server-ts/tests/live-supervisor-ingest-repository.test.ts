import { describe, expect, it } from "vitest";

import {
  createLiveSupervisorIngestRepository,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

describe("live supervisor ingest repository", () => {
  it("calls the existing DB functions and maps the gap contract without schema changes", async () => {
    const { sql, calls } = fakeSql([
      [{
        offset: "9",
        inserted: false,
        contiguous_upto: "1",
        highest_seen_event_id: "3",
        gap_start: "2",
        gap_end: "2",
      }],
      [{
        source_node: "node-a",
        source_session_id: "session-a",
        contiguous_upto: "1",
        highest_seen_event_id: "3",
        gap_start: "2",
        gap_end: "2",
        updated_at: new Date("2026-07-10T00:00:00Z"),
      }],
      [{
        id: 2,
        session_id: "session-a",
        event_type: "assistant_message",
        payload: { content: "hello" },
        searchable_text: "hello",
        created_at: new Date("2026-07-10T00:00:01Z"),
      }],
    ]);
    const repository = createLiveSupervisorIngestRepository({
      sqlResolver: resolver(sql),
    });

    await expect(repository.appendSupervisorEvent({
      sourceNode: "node-a",
      sourceSessionId: "session-a",
      sourceEventId: 3,
      eventType: "assistant_message",
      payload: { content: "hello" },
      createdAt: new Date("2026-07-10T00:00:01Z"),
    })).resolves.toEqual({
      offset: 9,
      inserted: false,
      contiguousUpto: 1,
      highestSeenEventId: 3,
      gapStart: 2,
      gapEnd: 2,
    });
    await expect(repository.getSupervisorSourceCursor("node-a", "session-a"))
      .resolves.toMatchObject({
        sourceNode: "node-a",
        sourceSessionId: "session-a",
        contiguousUpto: 1,
        highestSeenEventId: 3,
        gapStart: 2,
        gapEnd: 2,
      });
    await expect(repository.readEvents("session-a", 1, 500)).resolves.toEqual([{
      id: 2,
      eventType: "assistant_message",
      payload: { content: "hello" },
      createdAt: new Date("2026-07-10T00:00:01Z"),
    }]);

    expect(calls[0]?.query).toContain("supervisor_event_append");
    expect(calls[0]?.values).toEqual([
      "node-a",
      "session-a",
      3,
      "assistant_message",
      JSON.stringify({ content: "hello" }),
      new Date("2026-07-10T00:00:01Z"),
    ]);
    expect(calls[1]?.query).toContain("supervisor_source_cursor_get");
    expect(calls[1]?.values).toEqual(["node-a", "session-a"]);
    expect(calls[2]?.query).toContain("event_read");
    expect(calls[2]?.values).toEqual(["session-a", 1, 500, null]);
  });
});

type SqlCall = { query: string; values: unknown[] };

function fakeSql(responses: readonly unknown[][]): {
  sql: LivePostgresSql;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?"), values });
    return Promise.resolve(responses[index++] ?? []);
  }) as LivePostgresSql;
  return { sql, calls };
}

function resolver(sql: LivePostgresSql): LiveDbSqlResolver {
  return {
    resolveSql: async () => sql,
    close: async () => undefined,
  };
}
