import { describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import type { LiveSearchSql } from "../src/runtime/live_db_sql.js";
import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";
import { SessionReadRepository } from "../src/control_plane/repositories/session_read_repository.js";

describe("session-data read repositories", () => {
  it("owns all four session read queries and normalizes numeric summary fields", async () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const { sql, calls } = createSql((text) => {
      if (text.includes("session_get(")) return [{
        session_id: "s1",
        folder_id: null,
        predecessor_session_id: null,
      }];
      if (text.includes("WITH paged AS")) return [{
        session_id: "s1",
        display_name: "Session",
        created_at: now,
        updated_at: now,
        ...(text.includes("s.agent_id") ? { agent_id: "roselin" } : {}),
        node_id: "node-a",
        event_count: "4",
        last_event_id: "9",
        last_read_event_id: "5",
        total_count: "12",
      }];
      if (text.includes("WITH filtered AS")) return [{
        session_id: "s2",
        display_name: "Running",
        updated_at: now,
        total_count: "1",
      }];
      if (text.includes("SELECT COUNT(*) AS count")) return [{ count: "1" }];
      if (text.includes("FROM sessions s")) return [{ session_id: "s1" }];
      return [];
    });
    const repository = new SessionReadRepository(sql);

    await expect(repository.getSession("s1")).resolves.toMatchObject({ session_id: "s1" });
    await expect(repository.listSessionsSummary({ limit: 10, offset: 0 }))
      .resolves.toMatchObject({
        total: 12,
        sessions: [{
          agent_id: "roselin",
          node_id: "node-a",
          event_count: 4,
          last_event_id: 9,
          last_read_event_id: 5,
        }],
      });
    await expect(repository.listRunningSessionsSummary({ limit: 15, excludeSessionId: "s1" }))
      .resolves.toMatchObject({ total: 1, sessions: [{ session_id: "s2" }] });
    await expect(repository.listSessionsForUpstreamDump({ limit: 20, offset: 0, nodeId: "node-a" }))
      .resolves.toEqual({ sessions: [{ session_id: "s1", binding_warnings: [] }], total: 1 });

    expect(calls.map((call) => call.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("session_get("),
      expect.stringContaining("WITH paged AS"),
      expect.stringContaining("WITH filtered AS"),
      expect.stringContaining("FROM sessions s"),
    ]));
    const summaryQuery = calls.find((call) => call.text.includes("WITH paged AS"))?.text;
    expect(summaryQuery).toBeDefined();
    expect(summaryQuery).not.toContain("session_list_summary(");
    expect(summaryQuery).toContain("s.agent_id");
    expect(summaryQuery!.indexOf("LIMIT")).toBeLessThan(summaryQuery!.indexOf("FROM events"));
  });

  it("reads the caller chain in one recursive query with a cycle guard", async () => {
    const { sql, calls } = createSql((text) => {
      if (!text.includes("WITH RECURSIVE chain")) return [];
      return [
        {
          session_id: "s1",
          caller_session_id: "caller",
          model_preset: "claude-opus",
          model: "opus",
          agent_id: "seosoyoung",
          depth: 0,
        },
        {
          session_id: "caller",
          caller_session_id: null,
          model_preset: null,
          model: null,
          agent_id: "roselin",
          depth: 1,
        },
      ];
    });
    const repository = new SessionReadRepository(sql);

    const chain = await repository.getSessionCallerChain("s1");

    expect(chain.root).toEqual({
      session_id: "s1",
      caller_session_id: "caller",
      model_preset: "claude-opus",
      model: "opus",
      agent_id: "seosoyoung",
    });
    expect(chain.ancestors).toEqual([{
      session_id: "caller",
      caller_session_id: null,
      model_preset: null,
      model: null,
      agent_id: "roselin",
    }]);
    const queries = calls.filter((call) => call.text.includes("WITH RECURSIVE chain"));
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("visited");
    expect(queries[0]?.text).toContain("depth <");
    expect(queries[0]?.values).toEqual(["s1"]);
  });

  it("returns an empty chain root when the session row is missing", async () => {
    const { sql } = createSql(() => []);
    const repository = new SessionReadRepository(sql);

    await expect(repository.getSessionCallerChain("missing")).resolves.toEqual({
      root: null,
      ancestors: [],
    });
  });

  it("owns event read operations and preserves payload contracts", async () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const event = {
      id: 7,
      session_id: "s1",
      event_type: "user_message",
      payload: { text: "hello" },
      searchable_text: "hello",
      created_at: now,
    };
    const olderEvent = {
      ...event,
      id: 6,
      payload: { text: "older" },
      searchable_text: "older",
    };
    const rangeEvent = {
      ...event,
      id: 8,
      event_type: "error",
      payload: { error_code: "claude_rate_limit_stop_failure", resets_at: "2026-08-06T00:30:00Z" },
    };
    const { sql, calls } = createSql((text) => {
      if (text.includes("event_count(")) return [{ event_count: "8" }];
      if (text.includes("event_stream_raw(")) return [{
        id: 7,
        event_type: "user_message",
        payload_text: '{"text":"hello"}',
      }];
      if (text.includes("event_read_one(")) return [{ ...event, parent_event_id: 6 }];
      if (text.includes("AND id >") && text.includes("AND id <")) return [rangeEvent];
      if (text.includes("WITH picked AS")) {
        return text.includes("AND e.id >") ? [event] : [event, olderEvent];
      }
      if (text.includes("SELECT COUNT(*)::integer AS total_count")) {
        return [{ total_count: "3" }];
      }
      if (text.includes("event_search(") || text.includes("session_id_search(")) {
        return [{ ...event, score: "0.5" }];
      }
      if (text.includes("ORDER BY id DESC")) return [event, olderEvent];
      if (text.includes("event_read(")) return [event];
      return [];
    });
    const searchConnection = {
      sql: sql as unknown as LiveSearchSql,
      close: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const repository = new EventReadRepository(sql, {
      open: vi.fn(async () => searchConnection),
    });

    await expect(repository.countEvents("s1")).resolves.toBe(8);
    await expect(repository.readEvents("s1", 0, 50, ["user_message"]))
      .resolves.toEqual([event]);
    await expect(repository.readRecentEvents("s1", 50, ["user_message"]))
      .resolves.toEqual([olderEvent, event]);
    await expect(repository.readRecentEventsAfter("s1", 5, 1, ["user_message"]))
      .resolves.toEqual({ events: [event], total: 3 });
    await expect(repository.readEventsBetween("s1", 5, 9, ["credential_alert", "error"]))
      .resolves.toEqual([rangeEvent]);
    await expect(repository.readOneEvent("s1", 7))
      .resolves.toMatchObject({ id: 7, parent_event_id: 6, payload: { text: "hello" } });
    await expect(repository.streamEventsRaw("s1"))
      .resolves.toEqual([{ id: 7, event_type: "user_message", payload_text: '{"text":"hello"}' }]);
    await expect(repository.searchEvents("hello", ["s1"], 10, ["user_message"]))
      .resolves.toMatchObject([{ score: 0.5 }]);
    await expect(repository.searchEventsBySessionId("s1", null, 10))
      .resolves.toMatchObject([{ score: 0.5 }]);

    expect(calls.map((call) => call.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("event_count("),
      expect.stringContaining("event_read("),
      expect.stringContaining("WITH picked AS"),
      expect.stringContaining("ORDER BY e.id DESC"),
      expect.stringContaining("id > ? AND id < ?"),
      expect.stringContaining("event_read_one("),
      expect.stringContaining("event_stream_raw("),
      expect.stringContaining("event_search("),
      expect.stringContaining("session_id_search("),
    ]));
    expect(searchConnection.close).toHaveBeenCalledTimes(2);
    const rangeCall = calls.find((call) =>
      call.text.includes("AND id >") && call.text.includes("AND id <"));
    expect(rangeCall?.values).toEqual(["s1", 5, 9, ["credential_alert", "error"]]);
  });

  it("filters metadata rows by metadata_type in a direct SQL query", async () => {
    const now = new Date("2026-11-12T00:00:00.000Z");
    const event = {
      id: 12,
      session_id: "s1",
      event_type: "metadata",
      payload: { metadata_type: "persistent_generation" },
      searchable_text: "",
      created_at: now,
    };
    const { sql, calls } = createSql((text) => {
      if (text.includes("payload->>'metadata_type' = ANY")) return [event];
      if (text.includes("event_read(")) return [event];
      return [];
    });
    const repository = new EventReadRepository(sql);

    await expect(repository.readEvents(
      "s1",
      4,
      50,
      ["metadata"],
      undefined,
      ["persistent_generation"],
    )).resolves.toEqual([event]);
    await expect(repository.readEvents(
      "s1",
      4,
      50,
      ["metadata"],
      undefined,
      [],
    )).resolves.toEqual([event]);

    const filteredCall = calls.find((call) =>
      call.text.includes("payload->>'metadata_type' = ANY"));
    expect(filteredCall).toBeDefined();
    expect(filteredCall?.text).toContain("FROM events");
    expect(filteredCall?.text).toContain("AND id > ?");
    expect(filteredCall?.text).toContain("ORDER BY id ASC");
    expect(filteredCall?.text).not.toContain("event_read(");
    expect(filteredCall?.values).toEqual([
      "s1",
      4,
      ["metadata"],
      ["metadata"],
      ["persistent_generation"],
      50,
    ]);
    expect(calls.filter((call) => call.text.includes("event_read("))).toHaveLength(1);
  });

  it("cancels and discards its owned event search connection on request abort", async () => {
    let rejectPending!: (error: Error) => void;
    let resolveDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { resolveDispatched = resolve; });
    const cancel = vi.fn(() => rejectPending(new Error("cancelled")));
    const pending = new Promise<readonly Record<string, unknown>[]>((_resolve, reject) => {
      rejectPending = reject;
    }) as Promise<readonly Record<string, unknown>[]> & {
      cancel: () => void;
      canceller: (query: unknown) => void;
    };
    pending.cancel = cancel;
    pending.canceller = () => cancel();
    const searchSql = vi.fn(() => {
      resolveDispatched();
      return pending;
    }) as unknown as LiveSearchSql;
    const connection = {
      sql: searchSql,
      close: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const repository = new EventReadRepository(
      vi.fn() as unknown as SqlClient,
      { open: vi.fn(async () => connection) },
    );
    const controller = new AbortController();
    const result = repository.searchEvents("slow query", null, 10, null, controller.signal);
    await dispatched;
    controller.abort(new Error("caller disconnected"));

    await expect(result).rejects.toThrow("caller disconnected");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(connection.discard).toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
  });
});

function createSql(resultFor: (text: string, values: unknown[]) => unknown[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(resultFor(text, values));
  }) as unknown as SqlClient;
  return { sql, calls };
}
