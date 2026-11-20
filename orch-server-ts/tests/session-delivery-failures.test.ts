import { buildDeliveryInputUuid } from "@soulstream/wire-schema/delivery";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveDbCatalogRepository, type LivePostgresSql } from "../src/index.js";
import { registerPersistenceHostRoutes } from "../src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";

/**
 * 카드 #1524: 사람이 보낸 글이 전달 장부에서 dead_letter로 닫히면 그 말풍선에
 * 실패 표시를 켠다. orch는 (1) 실패 목록 조회를 내주고 (2) 사람 발신 실패가
 * 생기면 전역 스트림으로 그 세션을 알린다.
 */
describe("session delivery failures", () => {
  it("returns human dead-letter rows newest first with derived input ids", async () => {
    const deadLetteredAt = new Date("2026-11-18T06:15:04.000Z");
    const harness = createSqlHarness((text) =>
      text.includes("FROM session_deliveries")
        ? [
            {
              delivery_id: "298b09db-4c8d-4a63-9e51-9a5f3a4d7f21",
              dead_letter_reason: "runner_receipt_unknown",
              last_error: "runner_receipt_unknown",
              dead_lettered_at: deadLetteredAt,
            },
            {
              delivery_id: "delivery-no-reason",
              dead_letter_reason: null,
              last_error: "runner_receipt_unknown",
              dead_lettered_at: null,
            },
          ]
        : [],
    );
    const provider = createLiveDbCatalogRepository({
      sql: harness.sql,
    }).sessionHistoryProvider;

    await expect(provider.readDeliveryFailures!("03148db1-session")).resolves.toEqual([
      {
        input_id: buildDeliveryInputUuid("298b09db-4c8d-4a63-9e51-9a5f3a4d7f21"),
        reason: "runner_receipt_unknown",
        failed_at: deadLetteredAt,
      },
      {
        input_id: buildDeliveryInputUuid("delivery-no-reason"),
        reason: "runner_receipt_unknown",
        failed_at: null,
      },
    ]);

    expect(harness.calls).toHaveLength(1);
    const query = harness.calls[0]!;
    expect(query.text).toContain("FROM session_deliveries");
    expect(query.text).toContain("intent = 'human_live_steer'");
    expect(query.text).toContain("aggregate_state = 'dead_letter'");
    expect(query.text).toContain("payload->'caller_info'->>'source'");
    expect(query.text).toContain("IS DISTINCT FROM 'agent'");
    expect(query.text).toContain("ORDER BY COALESCE(dead_lettered_at, updated_at) DESC");
    expect(query.text).toContain("LIMIT 100");
    expect(query.values).toEqual(["03148db1-session"]);
  });
});

describe("session delivery failure notifications", () => {
  const TOKEN = "service-token";
  let app: ReturnType<typeof Fastify>;
  let notifications: string[];
  let deliveries: Record<string, (...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    notifications = [];
    deliveries = {};
    app = Fastify();
    registerPersistenceHostRoutes(app, {
      nodeCredentials: null,
      authBearerToken: TOKEN,
      repositoryProvider: async () =>
        ({ deliveries }) as unknown as PersistenceHostRepositories,
      onSessionDeliveryFailed: (sessionId) => notifications.push(sessionId),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function post(operation: string, args: unknown[]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/session-deliveries/host/${operation}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { args },
    });
    expect(response.statusCode).toBe(200);
    return response;
  }

  it("notifies the session once when a human message closes as dead_letter", async () => {
    deliveries.markUncertain = async () => humanDeadLetterRow("sess-human");

    const response = await post("mark_uncertain", [
      "delivery-1",
      "token-1",
      "runner_receipt_unknown",
    ]);

    expect(notifications).toEqual(["sess-human"]);
    expect(response.json()).toEqual(humanDeadLetterRow("sess-human"));
  });

  it("stays silent for an agent sender", async () => {
    deliveries.markUncertain = async () =>
      humanDeadLetterRow("sess-agent", { caller_info: { source: "agent" } });

    await post("mark_uncertain", ["delivery-2", "token-2", "runner_receipt_unknown"]);

    expect(notifications).toEqual([]);
  });

  it("stays silent while the retry budget leaves the delivery pending", async () => {
    deliveries.deferPending = async () => ({
      ...humanDeadLetterRow("sess-retry"),
      aggregate_state: "pending",
    });

    await post("defer_pending", ["delivery-3", "temporary failure", 1000]);

    expect(notifications).toEqual([]);
  });

  it("notifies once per session from the expiry sweep observer", async () => {
    deliveries.expireStaleDeliveryAttempts = async (...args: unknown[]) => {
      const onDeadLetterRow = args[0] as (row: unknown) => void;
      onDeadLetterRow(humanDeadLetterRow("sess-expired"));
      onDeadLetterRow(humanDeadLetterRow("sess-expired"));
      onDeadLetterRow(humanDeadLetterRow("sess-agent", { caller_info: { source: "agent" } }));
      return 3;
    };

    const response = await post("expire_stale_delivery_attempts", []);

    expect(notifications).toEqual(["sess-expired"]);
    expect(response.json()).toBe(3);
  });
});

function humanDeadLetterRow(
  sessionId: string,
  payload: Record<string, unknown> = { caller_info: { source: "browser" } },
) {
  return {
    delivery_id: `delivery-${sessionId}`,
    target_session_id: sessionId,
    intent: "human_live_steer",
    aggregate_state: "dead_letter",
    payload,
    dead_letter_reason: "runner_receipt_unknown",
  };
}

type SqlCall = {
  text: string;
  values: unknown[];
};

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[],
) {
  const calls: SqlCall[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    const flattened: unknown[] = [];
    for (let index = 0; index < values.length; index += 1) {
      text += "?";
      flattened.push(values[index]);
      text += strings[index + 1] ?? "";
    }
    calls.push({ text, values: flattened });
    return Promise.resolve(rowsFor(text, flattened));
  }) as unknown as LivePostgresSql;
  return { sql, calls };
}
