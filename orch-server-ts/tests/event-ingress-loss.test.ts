import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
} from "../src/node/event_ingress_repository.js";
import {
  FileEventIngressDeadLetterStore,
  type EventIngressDeadLetterStore,
} from "../src/node/event_ingress_dead_letter_store.js";
import { applyEventSessionEffect } from "../src/node/event_session_effect_applier.js";
import type {
  EventAppendBatch,
  EventIngressEnvelope,
} from "../src/node/event_ingress_types.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
const catalog = repositoryModelCatalog();
const GATE_ROW = {
  node_id: null,
  status: "running",
  termination_reason: null,
  termination_detail: null,
  review_state: "not_required",
  last_assistant_text: null,
  termination_event_id: null,
  last_event_id: null,
  updated_at: new Date("2026-08-06T00:00:00.000Z"),
  worktree_id: null,
  execution_registration_id: null,
  execution_command_id: null,
};

function envelope(overrides: Partial<EventIngressEnvelope> = {}): EventIngressEnvelope {
  return {
    stream_id: STREAM_ID,
    source_seq: 1,
    session_id: "session-a",
    event_type: "session",
    payload: { type: "session", session_id: "claude-new" },
    searchable_text: "",
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: { kind: "set_backend_session_id", backend_session_id: "claude-new" },
    payload_hash: "a".repeat(64),
    ...overrides,
  } as EventIngressEnvelope;
}

function batchOf(event: EventIngressEnvelope): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: event.source_seq,
    events: [event],
  };
}

function fakeSql(
  execute: (text: string, values: unknown[]) => Promise<readonly Record<string, unknown>[]>,
): EventIngressSql {
  const json = (value: unknown) => ({ __jsonParameter: value });
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    await execute(strings.join("?"), values)) as EventIngressQuerySql;
  const begin = async <T>(callback: (sql: EventIngressQuerySql) => Promise<T>) =>
    await callback(Object.assign(query, { json }) as EventIngressQuerySql);
  return Object.assign(query, { begin, json }) as EventIngressSql;
}

/** 사건 한 개가 커밋까지 가는 SQL 흐름. storedClaudeId는 sessions의 저장 값이다. */
function committingSql(
  statements: string[],
  storedClaudeId: string | null = null,
): EventIngressSql {
  return fakeSql(async (text) => {
    statements.push(text);
    if (text.includes("FROM event_ingress_receipts")) return [];
    if (text.includes("FROM sessions") && text.includes("FOR UPDATE")) return [GATE_ROW];
    if (text.includes("SELECT claude_session_id")) {
      return [{ claude_session_id: storedClaudeId }];
    }
    if (text.includes("session_set_claude_id")) {
      if (storedClaudeId && storedClaudeId !== "claude-new") {
        throw Object.assign(new Error("claude_session_id immutability violation"), {
          code: "P0001",
        });
      }
      return [];
    }
    if (text.includes("SELECT event_append")) return [{ event_id: 41 }];
    if (text.includes("INSERT INTO event_ingress_receipts")) return [];
    if (text.includes("UPDATE sessions")) return [];
    return [];
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("set_backend_session_id with a different stored claude_session_id", () => {
  it("commits the event, skips session_set_claude_id, and logs a warning", async () => {
    const statements: string[] = [];
    const repository = new EventIngressRepository(
      { resolveSql: async () => committingSql(statements, "claude-old") },
      applyEventSessionEffect,
      undefined,
      { modelCatalog: catalog },
    );

    const results = await repository.commitBatch("node-a", batchOf(envelope()));

    expect(results).toEqual([expect.objectContaining({ outcome: "committed", eventId: 41 })]);
    expect(statements.some((text) => text.includes("session_set_claude_id"))).toBe(false);
    expect(statements.some((text) => text.includes("INSERT INTO event_ingress_receipts"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "session-a",
      stored_claude_session_id: "claude-old",
      incoming_claude_session_id: "claude-new",
      event_id: 41,
    }));
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["same", "claude-new"],
  ])("still calls session_set_claude_id when the stored value is %s", async (_name, stored) => {
    const statements: string[] = [];
    const repository = new EventIngressRepository(
      { resolveSql: async () => committingSql(statements, stored) },
      applyEventSessionEffect,
      undefined,
      { modelCatalog: catalog },
    );

    const results = await repository.commitBatch("node-a", batchOf(envelope()));

    expect(results).toEqual([expect.objectContaining({ outcome: "committed" })]);
    expect(statements.filter((text) => text.includes("session_set_claude_id"))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the stored value without a lock", async () => {
    const statements: string[] = [];
    const sql = fakeSql(async (text) => {
      statements.push(text);
      return [{ claude_session_id: null }];
    });

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 7,
      envelope: envelope(),
      effect: { kind: "set_backend_session_id", backend_session_id: "claude-new" },
    });

    const read = statements.find((text) => text.includes("SELECT claude_session_id"))!;
    expect(read).not.toMatch(/FOR\s+(UPDATE|SHARE)/);
  });
});

describe("retrying failure record after a successful commit", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "event-ingress-loss-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function repositoryWith(
    store: EventIngressDeadLetterStore,
    sql: EventIngressSql,
  ): EventIngressRepository {
    return new EventIngressRepository(
      { resolveSql: async () => sql },
      applyEventSessionEffect,
      store,
      { modelCatalog: catalog, failureThreshold: 3, retryDelaysMs: [0, 0], sleep: async () => undefined },
    );
  }

  const plain = () => envelope({ session_effect: null, event_type: "assistant_message" });
  const failure = { reason: "boom", errorName: "Error" };

  it("deletes a retrying record once the event commits", async () => {
    const store = new FileEventIngressDeadLetterStore(directory);
    await store.recordFailure({ nodeId: "node-a", envelope: plain(), failure, threshold: 3 });
    expect(await readdir(directory)).toHaveLength(1);

    const results = await repositoryWith(store, committingSql([])).commitBatch(
      "node-a",
      batchOf(plain()),
    );

    expect(results).toEqual([expect.objectContaining({ outcome: "committed" })]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps a dead_lettered record", async () => {
    const store = new FileEventIngressDeadLetterStore(directory);
    for (let i = 0; i < 3; i += 1) {
      await store.recordFailure({ nodeId: "node-a", envelope: plain(), failure, threshold: 3 });
    }

    const results = await repositoryWith(store, committingSql([])).commitBatch(
      "node-a",
      batchOf(plain()),
    );

    expect(results).toEqual([expect.objectContaining({ outcome: "dead_lettered" })]);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("keeps the retrying record when the outcome is not a commit (STALE_REGISTRATION)", async () => {
    const store = new FileEventIngressDeadLetterStore(directory);
    const stale = envelope({ session_effect: null, event_type: "assistant_message", registration_id: "reg-x" });
    await store.recordFailure({ nodeId: "node-a", envelope: stale, failure, threshold: 3 });

    const results = await repositoryWith(store, committingSql([])).commitBatch(
      "node-a",
      batchOf(stale),
    );

    expect(results).toEqual([expect.objectContaining({ outcome: "dead_lettered" })]);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("does not fail the ingress result when removal fails", async () => {
    const real = new FileEventIngressDeadLetterStore(directory);
    await real.recordFailure({ nodeId: "node-a", envelope: plain(), failure, threshold: 3 });
    const store: EventIngressDeadLetterStore = {
      find: (input) => real.find(input),
      recordFailure: (input) => real.recordFailure(input),
      removeRetrying: async () => {
        throw new Error("EACCES");
      },
    };

    const results = await repositoryWith(store, committingSql([])).commitBatch(
      "node-a",
      batchOf(plain()),
    );

    expect(results).toEqual([expect.objectContaining({ outcome: "committed" })]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      cause_code: "EVENT_INGRESS_RETRYING_RECORD_REMOVE_FAILED",
    }));
  });

  it("does not touch the store again for an event that had no record", async () => {
    const real = new FileEventIngressDeadLetterStore(directory);
    const removeRetrying = vi.fn(async () => undefined);
    const store: EventIngressDeadLetterStore = {
      find: (input) => real.find(input),
      recordFailure: (input) => real.recordFailure(input),
      removeRetrying,
    };

    await repositoryWith(store, committingSql([])).commitBatch("node-a", batchOf(plain()));

    expect(removeRetrying).not.toHaveBeenCalled();
  });
});
