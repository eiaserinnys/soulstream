import { describe, expect, it, vi } from "vitest";

import {
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
} from "../../src/node/event_ingress_repository.js";
import type { EventAppendBatch } from "../../src/node/event_ingress_types.js";
import { repositoryModelCatalog } from "../helpers/model_catalog.js";

const catalog = repositoryModelCatalog();
const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";

const USAGE_PAYLOAD = {
  type: "complete",
  output_command_id: "command-statistics",
  usage_snapshot: {
    schema_version: 1,
    backend: "codex",
    provider: "codex",
    preset_id: null,
    requested_model: "gpt-6-luna",
    provider_attribution: "configured_alias",
  },
  usage: {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  },
};

describe("session statistics stream notifications", () => {
  it("announces inserted facts only after the transaction commits", async () => {
    const listener = vi.fn();
    let listenerCallsInsideTransaction: number | undefined;
    const statements: string[] = [];
    const execute = async (text: string) => {
      statements.push(text);
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR NO KEY UPDATE")) {
        return [{ execution_registration_id: null }];
      }
      if (text.includes("SELECT event_append")) return [{ event_id: 41 }];
      if (text.includes("INSERT INTO session_statistics_facts")) return [];
      if (text.includes("INSERT INTO event_ingress_receipts")) return [];
      throw new Error(`unexpected SQL: ${text}`);
    };
    const sql = fakeSql(execute, (result) => {
      listenerCallsInsideTransaction = listener.mock.calls.length;
      return result;
    });
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      undefined,
      { modelCatalog: catalog, onSessionStatisticsFactsInserted: listener },
    );

    const results = await repository.commitBatch("node-a", usageBatch());

    expect(statements.some((text) => text.includes("INSERT INTO session_statistics_facts")))
      .toBe(true);
    expect(listenerCallsInsideTransaction).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(results).toMatchObject([{ outcome: "committed", eventId: 41 }]);
  });

  it("does not announce facts from a rolled-back transaction", async () => {
    const listener = vi.fn();
    const sql = fakeSql(async (text) => {
      if (text.includes("FROM event_ingress_receipts")) return [];
      if (text.includes("FROM sessions") && text.includes("FOR NO KEY UPDATE")) {
        return [{ execution_registration_id: null }];
      }
      if (text.includes("SELECT event_append")) return [{ event_id: 41 }];
      if (text.includes("INSERT INTO session_statistics_facts")) return [];
      if (text.includes("INSERT INTO event_ingress_receipts")) {
        throw new Error("receipt insert failed");
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new EventIngressRepository(
      { resolveSql: async () => sql },
      undefined,
      undefined,
      { modelCatalog: catalog, onSessionStatisticsFactsInserted: listener },
    );

    await expect(repository.commitBatch("node-a", usageBatch()))
      .rejects.toThrow("receipt insert failed");
    expect(listener).not.toHaveBeenCalled();
  });
});

function usageBatch(): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: 1,
    events: [{
      stream_id: STREAM_ID,
      source_seq: 1,
      session_id: "session-a",
      event_type: "complete",
      payload: USAGE_PAYLOAD,
      searchable_text: null,
      created_at: "2026-11-19T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "a".repeat(64),
    }],
  };
}

function fakeSql(
  execute: (text: string) => Promise<readonly Record<string, unknown>[]>,
  observeTransaction?: (result: unknown) => void,
): EventIngressSql {
  const json = (value: unknown) => value;
  const query = (async (strings: TemplateStringsArray) =>
    await execute(strings.join("?"))) as EventIngressQuerySql;
  const transactionSql = Object.assign(query, { json }) as EventIngressQuerySql;
  const begin = async <T>(callback: (sql: EventIngressQuerySql) => Promise<T>) => {
    const result = await callback(transactionSql);
    observeTransaction?.(result);
    return result;
  };
  return Object.assign(query, { begin, json }) as EventIngressSql;
}
