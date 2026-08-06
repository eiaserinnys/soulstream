import { describe, expect, it, vi } from "vitest";

import {
  EventIngressProtocolConflict,
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
} from "../src/node/event_ingress_repository.js";
import type { EventAppendBatch } from "../src/node/event_ingress_types.js";

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";

describe("EventIngressRepository", () => {
  it("commits event append, typed effect, and receipt in one transaction", async () => {
    const order: string[] = [];
    const sql = fakeSql(async (text, values) => {
      if (text.includes("FROM event_ingress_receipts")) {
        order.push("receipt-read");
        return [];
      }
      if (text.includes("SELECT event_append")) {
        order.push("event-append");
        expect(values.slice(0, 3)).toEqual([
          "session-a",
          "assistant_message",
          JSON.stringify({ type: "assistant_message", content: "done" }),
        ]);
        expect(values[5]).toBe("semantic-1");
        return [{ event_id: 41 }];
      }
      if (text.includes("INSERT INTO event_ingress_receipts")) {
        order.push("receipt-insert");
        return [];
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const effect = vi.fn(async () => {
      order.push("session-effect");
    });
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      effect,
    );

    const committed = await repository.commitBatch("node-a", batch({
      session_effect: { kind: "last_message", preview: "done" },
    }));

    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "receipt-read",
      "event-append",
      "session-effect",
      "receipt-insert",
    ]);
    expect(committed).toEqual([{ envelope: batch({
      session_effect: { kind: "last_message", preview: "done" },
    }).events[0], eventId: 41, duplicateReceipt: false }]);
  });

  it("returns an existing receipt without re-appending the semantic event", async () => {
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) {
        return [{ session_id: "session-a", payload_hash: "a".repeat(64), event_id: 17 }];
      }
      throw new Error("duplicate receipt must not execute another statement");
    });
    const repository = new EventIngressRepository({ resolveSql: async () => sql });

    await expect(repository.commitBatch("node-a", batch())).resolves.toMatchObject([
      { eventId: 17, duplicateReceipt: true },
    ]);
  });

  it("raises a 409 protocol conflict for the same ingress key with another hash", async () => {
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) {
        return [{ session_id: "session-a", payload_hash: "b".repeat(64), event_id: 17 }];
      }
      return [];
    });
    const repository = new EventIngressRepository({ resolveSql: async () => sql });

    await expect(repository.commitBatch("node-a", batch())).rejects.toMatchObject({
      constructor: EventIngressProtocolConflict,
      statusCode: 409,
    });
  });
});

function batch(overrides: Partial<EventAppendBatch["events"][number]> = {}): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: 1,
    events: [{
      stream_id: STREAM_ID,
      source_seq: 1,
      session_id: "session-a",
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "done" },
      searchable_text: "done",
      created_at: "2026-08-06T00:00:00.000Z",
      semantic_dedupe_key: "semantic-1",
      session_effect: null,
      payload_hash: "a".repeat(64),
      ...overrides,
    }],
  };
}

function fakeSql(
  execute: (text: string, values: unknown[]) => Promise<readonly Record<string, unknown>[]>,
): EventIngressSql & { begin: ReturnType<typeof vi.fn> } {
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    await execute(strings.join("?"), values)) as EventIngressQuerySql;
  const begin = vi.fn(async <T>(callback: (sql: EventIngressQuerySql) => Promise<T>) =>
    await callback(query));
  return Object.assign(query, { begin }) as EventIngressSql & { begin: ReturnType<typeof vi.fn> };
}
