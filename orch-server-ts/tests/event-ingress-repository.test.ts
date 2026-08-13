import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EventIngressProtocolConflict,
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
} from "../src/node/event_ingress_repository.js";
import { FileEventIngressDeadLetterStore } from "../src/node/event_ingress_dead_letter_store.js";
import type { EventAppendBatch } from "../src/node/event_ingress_types.js";

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";

describe("EventIngressRepository", () => {
  it("commits event append, typed effect, and receipt in one transaction", async () => {
    const order: string[] = [];
    const sql = fakeSql(async (text, values) => {
      if (text.includes("FROM event_ingress_receipts")) {
        order.push("receipt-read");
        expect(values).toEqual(["node-a", STREAM_ID, 2]);
        return [];
      }
      if (text.includes("FROM sessions") && text.includes("FOR KEY SHARE")) {
        order.push("session-lock");
        return [{ session_id: "session-a" }];
      }
      if (text.includes("pg_advisory_xact_lock")) {
        order.push("semantic-lock");
        return [];
      }
      if (text.includes("FROM events") && text.includes("dedupe_key")) {
        order.push("semantic-read");
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
        expect(values).toEqual([
          "node-a",
          STREAM_ID,
          2,
          "session-a",
          "a".repeat(64),
          41,
          null,
        ]);
        return [];
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const effect = vi.fn(async () => {
      order.push("session-effect");
      return { applied: true, canonicalSession: null };
    });
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      effect,
    );

    const committed = await repository.commitBatch("node-a", batch({
      session_effect: {
        kind: "last_message",
        last_message: { type: "assistant_message", preview: "done", timestamp: "2026-08-06T00:00:00.000Z" },
        updated_at: "2026-08-06T00:00:00.000Z",
      },
    }, 2));

    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "receipt-read",
      "session-lock",
      "semantic-lock",
      "semantic-read",
      "event-append",
      "session-effect",
      "receipt-insert",
    ]);
    expect(committed).toEqual([{ envelope: batch({
      session_effect: {
        kind: "last_message",
        last_message: { type: "assistant_message", preview: "done", timestamp: "2026-08-06T00:00:00.000Z" },
        updated_at: "2026-08-06T00:00:00.000Z",
      },
    }, 2).events[0], outcome: "committed", eventId: 41, duplicateReceipt: false,
    sessionEffectApplication: { applied: true, canonicalSession: null } }]);
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

  it("replays the exact canonical effect application from a durable transport receipt", async () => {
    const canonicalSession = {
      status: "completed",
      termination_reason: "completed_ok",
      termination_detail: null,
      review_state: "needs_review",
      last_assistant_text: "done",
      termination_event_id: 41,
      updated_at: "2026-08-06T00:01:00.000Z",
      last_event_id: 42,
    };
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) {
        return [{
          session_id: "session-a",
          payload_hash: "a".repeat(64),
          event_id: 42,
          effect_application: {
            applied: false,
            canonical_session: canonicalSession,
          },
        }];
      }
      throw new Error("durable receipt replay must not execute another statement");
    });
    const effect = vi.fn();
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      effect,
    );

    await expect(repository.commitBatch("node-a", batch({
      event_type: "metadata",
      session_effect: {
        kind: "running_transition",
        review_state: "acknowledged",
        expected_terminal_event_id: 999,
        updated_at: "2026-08-06T00:00:00.000Z",
      },
    }))).resolves.toMatchObject([{
      eventId: 42,
      duplicateReceipt: true,
      sessionEffectApplication: {
        applied: false,
        canonicalSession,
      },
    }]);
    expect(effect).not.toHaveBeenCalled();
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

  it("applies a semantic event effect once across distinct transport receipts", async () => {
    let semanticEventId: number | undefined;
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR KEY SHARE")) {
        return [{ session_id: "session-a" }];
      }
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("FROM events") && text.includes("dedupe_key")) {
        return semanticEventId ? [{ event_id: semanticEventId }] : [];
      }
      if (text.includes("SELECT event_append")) {
        semanticEventId = 41;
        return [{ event_id: semanticEventId }];
      }
      if (text.includes("INSERT INTO event_ingress_receipts")) return [];
      throw new Error(`unexpected SQL: ${text}`);
    });
    const effect = vi.fn(async () => ({ applied: true, canonicalSession: null }));
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      effect,
    );
    const sessionEffect = {
      kind: "append_metadata" as const,
      entry: { type: "runner_snapshot", value: { state: "ready" } },
      updated_at: "2026-08-06T00:00:00.000Z",
    };

    const first = await repository.commitBatch(
      "node-a",
      batch({ session_effect: sessionEffect }, 2),
    );
    const replay = await repository.commitBatch("node-a", batch({
      session_effect: sessionEffect,
      payload_hash: "b".repeat(64),
    }, 3));

    expect(first[0]).toMatchObject({ outcome: "committed", duplicateReceipt: false });
    expect(replay[0]).toMatchObject({ outcome: "committed", duplicateReceipt: true });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("dead-letters exactly two deleted-session head events without calling event_append", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-ingress-dead-letter-"));
    try {
      const statements: string[] = [];
      const sql = fakeSql(async (text) => {
        statements.push(text);
        if (text.includes("FROM event_ingress_receipts")) return [];
        if (text.includes("FROM sessions") && text.includes("FOR KEY SHARE")) return [];
        throw new Error(`deleted-session event must not reach another statement: ${text}`);
      });
      const store = new FileEventIngressDeadLetterStore(directory, () =>
        new Date("2026-08-13T00:00:00.000Z"));
      const repository = new EventIngressRepository(
        { resolveSql: async () => sql },
        undefined,
        store,
      );
      const input = batch({}, 1);
      input.events.push({
        ...input.events[0]!,
        source_seq: 2,
        payload: { type: "assistant_message", content: "second" },
        payload_hash: "b".repeat(64),
      });

      const results = await repository.commitBatch("node-a", input);

      expect(results).toEqual([
        expect.objectContaining({
          outcome: "dead_lettered",
          envelope: expect.objectContaining({ source_seq: 1 }),
          deadLetter: expect.objectContaining({ code: "SESSION_NOT_FOUND" }),
        }),
        expect.objectContaining({
          outcome: "dead_lettered",
          envelope: expect.objectContaining({ source_seq: 2 }),
          deadLetter: expect.objectContaining({ code: "SESSION_NOT_FOUND" }),
        }),
      ]);
      expect(statements.some((text) => text.includes("SELECT event_append"))).toBe(false);
      const firstPath = results[0]!.outcome === "dead_lettered"
        ? results[0]!.deadLetter.path
        : "";
      const stored = JSON.parse(await readFile(firstPath, "utf8")) as Record<string, unknown>;
      expect(stored).toMatchObject({
        code: "SESSION_NOT_FOUND",
        node_id: "node-a",
        rejected_at: "2026-08-13T00:00:00.000Z",
        envelope: expect.objectContaining({
          source_seq: 1,
          session_id: "session-a",
          payload: { type: "assistant_message", content: "done" },
        }),
      });
      const statementCount = statements.length;
      const replay = await repository.commitBatch("node-a", input);
      expect(replay).toEqual(results);
      expect(statements).toHaveLength(statementCount);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps non-session FK failures retryable instead of dead-lettering them", async () => {
    const persist = vi.fn();
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR KEY SHARE")) {
        return [{ session_id: "session-a" }];
      }
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("FROM events") && text.includes("dedupe_key")) return [];
      if (text.includes("SELECT event_append")) {
        throw Object.assign(new Error("another foreign key failed"), { code: "23503" });
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      { find: vi.fn(async () => null), persist },
    );

    await expect(repository.commitBatch("node-a", batch())).rejects.toMatchObject({
      code: "23503",
    });
    expect(persist).not.toHaveBeenCalled();
  });
});

function batch(
  overrides: Partial<EventAppendBatch["events"][number]> = {},
  sourceSeq = 1,
): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: sourceSeq,
    events: [{
      stream_id: STREAM_ID,
      source_seq: sourceSeq,
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
