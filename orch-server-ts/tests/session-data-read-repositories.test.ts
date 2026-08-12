import { describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
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
      if (text.includes("session_list_summary(")) return [{
        session_id: "s1",
        display_name: "Session",
        created_at: now,
        updated_at: now,
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
        sessions: [{ event_count: 4, last_event_id: 9, last_read_event_id: 5 }],
      });
    await expect(repository.listRunningSessionsSummary({ limit: 15, excludeSessionId: "s1" }))
      .resolves.toMatchObject({ total: 1, sessions: [{ session_id: "s2" }] });
    await expect(repository.listSessionsForUpstreamDump({ limit: 20, offset: 0, nodeId: "node-a" }))
      .resolves.toEqual({ sessions: [{ session_id: "s1", binding_warnings: [] }], total: 1 });

    expect(calls.map((call) => call.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("session_get("),
      expect.stringContaining("session_list_summary("),
      expect.stringContaining("WITH filtered AS"),
      expect.stringContaining("FROM sessions s"),
    ]));
  });

  it("owns all seven event read operations and preserves payload contracts", async () => {
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
    const { sql, calls } = createSql((text) => {
      if (text.includes("event_count(")) return [{ event_count: "8" }];
      if (text.includes("event_stream_raw(")) return [{
        id: 7,
        event_type: "user_message",
        payload_text: '{"text":"hello"}',
      }];
      if (text.includes("event_read_one(")) return [{ ...event, parent_event_id: 6 }];
      if (text.includes("event_search(") || text.includes("session_id_search(")) {
        return [{ ...event, score: "0.5" }];
      }
      if (text.includes("ORDER BY id DESC")) return [event, olderEvent];
      if (text.includes("event_read(")) return [event];
      return [];
    });
    const repository = new EventReadRepository(sql);

    await expect(repository.countEvents("s1")).resolves.toBe(8);
    await expect(repository.readEvents("s1", 0, 50, ["user_message"]))
      .resolves.toEqual([event]);
    await expect(repository.readRecentEvents("s1", 50, ["user_message"]))
      .resolves.toEqual([olderEvent, event]);
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
      expect.stringContaining("ORDER BY id DESC"),
      expect.stringContaining("event_read_one("),
      expect.stringContaining("event_stream_raw("),
      expect.stringContaining("event_search("),
      expect.stringContaining("session_id_search("),
    ]));
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
