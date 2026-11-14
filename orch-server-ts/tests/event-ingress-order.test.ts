import { describe, expect, it, vi } from "vitest";

import {
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
} from "../src/node/event_ingress_repository.js";
import { classifyEventIngressFailure } from "../src/node/event_ingress_retry_policy.js";
import type {
  EventAppendBatch,
  EventIngressEnvelope,
} from "../src/node/event_ingress_types.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

const catalog = repositoryModelCatalog();

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";

describe("event ingress batch ordering", () => {
  it("defers later same-session events behind a failed head and applies other sessions in the same round", async () => {
    const applied: number[] = [];
    const attempts = new Map<number, number>();
    const sql = fakeSql(async (text, values) => {
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR NO KEY UPDATE")) {
        return [{ execution_registration_id: null, execution_command_id: null }];
      }
      if (text.includes("SELECT event_append")) {
        const sourceSeq = sourceSeqFromPayload(values[2]);
        const attempt = (attempts.get(sourceSeq) ?? 0) + 1;
        attempts.set(sourceSeq, attempt);
        // The head event of session-a fails once in the first round.
        if (sourceSeq === 1 && attempt === 1) {
          throw new Error("first round failure");
        }
        applied.push(sourceSeq);
        return [{ event_id: 100 + sourceSeq }];
      }
      if (text.includes("INSERT INTO event_ingress_receipts")) return [];
      if (text.includes("SELECT 1 AS event_ingress_health")) {
        return [{ event_ingress_health: 1 }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const recordFailure = vi.fn(async (_input: {
      nodeId: string;
      envelope: EventIngressEnvelope;
      failure: unknown;
      threshold: number;
    }) => ({
      failureCount: 1,
      deadLetter: null,
    }));
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      { find: vi.fn(async () => null), recordFailure },
      { modelCatalog: catalog, sleep: async () => undefined },
    );
    const input = batchOf([
      envelope(1, "session-a", "first", "a"),
      envelope(2, "session-a", "second", "b"),
      envelope(3, "session-b", "other", "c"),
    ]);

    const results = await repository.commitBatch("node-a", input);

    // The other session is not blocked; the same-session events apply 1 then 2.
    expect(applied).toEqual([3, 1, 2]);
    expect(results.map((result) => result.outcome)).toEqual([
      "committed",
      "committed",
      "committed",
    ]);
    expect(results.map((result) =>
      result.outcome === "committed" ? result.eventId : null)).toEqual([101, 102, 103]);
    // Only the head event failed; the deferred event never earns a failure count.
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure.mock.calls[0]![0]).toMatchObject({
      envelope: { source_seq: 1 },
      threshold: 5,
    });
  });
});

describe("event ingress transient failures", () => {
  it("does not permanently reject an event that fails transiently six times before succeeding", async () => {
    let attempts = 0;
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR NO KEY UPDATE")) {
        return [{ execution_registration_id: null, execution_command_id: null }];
      }
      if (text.includes("SELECT event_append")) {
        attempts += 1;
        if (attempts <= 6) {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        }
        return [{ event_id: 77 }];
      }
      if (text.includes("INSERT INTO event_ingress_receipts")) return [];
      if (text.includes("SELECT 1 AS event_ingress_health")) {
        return [{ event_ingress_health: 1 }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    let failures = 0;
    const recordFailure = vi.fn(async ({ threshold }: { threshold: number }) => {
      failures += 1;
      return {
        failureCount: failures,
        deadLetter: failures < threshold
          ? null
          : {
              code: "REPEATED_FAILURE" as const,
              reason: "deadlock detected",
              rejectedAt: "2026-11-12T00:00:00.000Z",
              path: "/dead-letter/transient.json",
            },
      };
    });
    const delays: number[] = [];
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      { find: vi.fn(async () => null), recordFailure },
      {
        modelCatalog: catalog,
        failureThreshold: 3,
        retryDelaysMs: [10, 20],
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    const results = await repository.commitBatch("node-a", batchOf([
      envelope(1, "session-a", "first", "a"),
    ]));

    expect(results).toMatchObject([{ outcome: "committed", eventId: 77 }]);
    expect(attempts).toBe(7);
    expect(recordFailure).not.toHaveBeenCalled();
    // The existing stages are reused and the last one repeats.
    expect(delays).toEqual([10, 20, 20, 20, 20, 20]);
  });

  it.each([
    { label: "a general error", makeError: () => new Error("malformed event") },
    {
      label: "a unique violation",
      makeError: () => Object.assign(
        new Error("duplicate key value violates unique constraint"),
        { code: "23505" },
      ),
    },
  ])("permanently rejects $label after five failures", async ({ makeError }) => {
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR NO KEY UPDATE")) {
        return [{ execution_registration_id: null, execution_command_id: null }];
      }
      if (text.includes("SELECT event_append")) throw makeError();
      if (text.includes("SELECT 1 AS event_ingress_health")) {
        return [{ event_ingress_health: 1 }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    let failures = 0;
    const recordFailure = vi.fn(async ({ threshold }: { threshold: number }) => {
      failures += 1;
      return {
        failureCount: failures,
        deadLetter: failures < threshold
          ? null
          : {
              code: "REPEATED_FAILURE" as const,
              reason: "permanent event failure",
              rejectedAt: "2026-11-12T00:00:00.000Z",
              path: "/dead-letter/permanent.json",
            },
      };
    });
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      { find: vi.fn(async () => null), recordFailure },
      {
        modelCatalog: catalog,
        retryDelaysMs: [0, 0, 0, 0],
        sleep: async () => undefined,
      },
    );

    const results = await repository.commitBatch("node-a", batchOf([
      envelope(1, "session-a", "first", "a"),
    ]));

    expect(results).toMatchObject([{
      outcome: "dead_lettered",
      deadLetter: { code: "REPEATED_FAILURE" },
    }]);
    expect(recordFailure).toHaveBeenCalledTimes(5);
  });
});

describe("classifyEventIngressFailure", () => {
  it.each([
    { label: "deadlock", error: () => withCode("40P01"), expected: "transient" },
    { label: "serialization failure", error: () => withCode("40001"), expected: "transient" },
    { label: "lock not available", error: () => withCode("55P03"), expected: "transient" },
    { label: "statement timeout", error: () => withCode("57014"), expected: "transient" },
    { label: "admin shutdown", error: () => withCode("57P01"), expected: "transient" },
    { label: "crash shutdown", error: () => withCode("57P02"), expected: "transient" },
    { label: "cannot connect now", error: () => withCode("57P03"), expected: "transient" },
    { label: "connection exception", error: () => withCode("08000"), expected: "transient" },
    { label: "connection failure", error: () => withCode("08006"), expected: "transient" },
    { label: "protocol violation", error: () => withCode("08P01"), expected: "transient" },
    { label: "reset connection", error: () => withCode("ECONNRESET"), expected: "transient" },
    { label: "refused connection", error: () => withCode("ECONNREFUSED"), expected: "transient" },
    { label: "timed out connection", error: () => withCode("ETIMEDOUT"), expected: "transient" },
    { label: "broken pipe", error: () => withCode("EPIPE"), expected: "transient" },
    {
      label: "terminated connection",
      error: () => new Error("Connection terminated unexpectedly"),
      expected: "transient",
    },
    {
      label: "terminated connection timeout",
      error: () => new Error("Connection terminated due to connection timeout"),
      expected: "transient",
    },
    { label: "plain error", error: () => new Error("malformed event"), expected: "event" },
    { label: "unique violation", error: () => withCode("23505"), expected: "event" },
    { label: "foreign key violation", error: () => withCode("23503"), expected: "event" },
    { label: "protocol conflict", error: () => withCode("XX000"), expected: "event" },
    { label: "null", error: () => null, expected: "event" },
    { label: "undefined", error: () => undefined, expected: "event" },
    { label: "string", error: () => "boom", expected: "event" },
  ])("classifies $label as $expected", ({ error, expected }) => {
    expect(classifyEventIngressFailure(error())).toBe(expected);
  });
});

function withCode(code: string): Error {
  return Object.assign(new Error(`database error ${code}`), { code });
}

function sourceSeqFromPayload(payload: unknown): number {
  const parsed = JSON.parse(String(payload)) as { content: string };
  return Number(parsed.content.replace(/\D+/g, ""));
}

function batchOf(events: EventIngressEnvelope[]): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: events[0]!.source_seq,
    events,
  };
}

function envelope(
  sourceSeq: number,
  sessionId: string,
  content: string,
  hashChar: string,
): EventIngressEnvelope {
  return {
    stream_id: STREAM_ID,
    source_seq: sourceSeq,
    session_id: sessionId,
    event_type: "assistant_message",
    payload: { type: "assistant_message", content: `${content}-${sourceSeq}` },
    searchable_text: content,
    created_at: "2026-11-12T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
    payload_hash: hashChar.repeat(64),
  };
}

function fakeSql(
  execute: (
    text: string,
    values: unknown[],
  ) => Promise<readonly Record<string, unknown>[]>,
): EventIngressSql {
  const json = vi.fn((value: unknown) => ({ __jsonParameter: value }));
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    await execute(strings.join("?"), values)) as EventIngressQuerySql;
  const begin = vi.fn(
    async <T>(callback: (sql: EventIngressQuerySql) => Promise<T>) =>
      await callback(Object.assign(query, { json }) as EventIngressQuerySql),
  );
  return Object.assign(query, { begin, json }) as EventIngressSql;
}
