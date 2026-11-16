/**
 * card #1380 — 같은 delivery_id로 다시 온 요청이 caller_info.agent_node만 달라
 * 409 DELIVERY_IDENTITY_CONFLICT가 되던 문제. 그 값은 요청 순간 노드 등록부
 * 조회 결과라(재시작 직후 ""였다가 노드가 붙으면 노드 id) 같은 전달의 재전송이
 * 다른 본문으로 보였다. 해시 함수와 저장된 payload_hash는 그대로 두고, 충돌
 * 판정 두 곳이 caller_info.agent_node만 뺀 payload 비교로 재전송을 알아본다.
 * 다른 필드가 다르면 지금처럼 충돌이다.
 */
import { describe, expect, it, vi } from "vitest";

import { deliveryPayloadsMatchIgnoringCallerAgentNode } from
  "@soulstream/wire-schema/delivery";

import type {
  SessionDeliveryRow,
  SqlClient,
} from "../src/control_plane/control_plane_types.js";
import { SessionDeliveryRepository } from
  "../src/control_plane/repositories/session_delivery_repository.js";

describe("deliveryPayloadsMatchIgnoringCallerAgentNode", () => {
  it("treats payloads that differ only by caller_info.agent_node as the same", () => {
    expect(deliveryPayloadsMatchIgnoringCallerAgentNode(
      { text: "점검 알림", caller_info: { source: "agent", agent_node: "" } },
      { text: "점검 알림", caller_info: { source: "agent", agent_node: "eiaserinnys" } },
    )).toBe(true);
  });

  it("compares canonicalized key order and nested values", () => {
    expect(deliveryPayloadsMatchIgnoringCallerAgentNode(
      {
        caller_info: { agent_node: "node-a", source: "agent" },
        text: "점검 알림",
        context: { b: 1, a: [2, 3] },
      },
      {
        context: { a: [2, 3], b: 1 },
        text: "점검 알림",
        caller_info: { source: "agent" },
      },
    )).toBe(true);
  });

  it("still reports other payload differences", () => {
    expect(deliveryPayloadsMatchIgnoringCallerAgentNode(
      { text: "점검 알림", caller_info: { source: "agent", agent_node: "node-a" } },
      { text: "다른 본문", caller_info: { source: "agent", agent_node: "node-a" } },
    )).toBe(false);
    expect(deliveryPayloadsMatchIgnoringCallerAgentNode(
      { text: "점검 알림", caller_info: { source: "agent", agent_node: "node-a" } },
      { text: "점검 알림", caller_info: { source: "browser", agent_node: "node-a" } },
    )).toBe(false);
    expect(deliveryPayloadsMatchIgnoringCallerAgentNode(
      { text: "점검 알림" },
      { text: "점검 알림", caller_info: { agent_node: "node-a" } },
    )).toBe(false);
  });
});

describe("session delivery identity with caller_info.agent_node", () => {
  it("treats a re-registration that differs only by agent_node as the same delivery", async () => {
    const existing = deliveryRow({
      payload_hash: "hash-empty-agent-node",
      payload: { text: "점검 알림", caller_info: { source: "agent", agent_node: "" } },
      state: "queued",
    });
    const { sql, calls } = createDeliverySql({ insert: [], existing });
    const repository = new SessionDeliveryRepository(sql);

    const result = await repository.register({
      deliveryId: "haniel-inspection-1",
      targetSessionId: "target-1",
      relationKey: "user_message:target-1:haniel-inspection-1",
      completionId: "message:haniel-inspection-1",
      intent: "human_live_steer",
      source: "user_message",
      payloadHash: "hash-with-node-agent-node",
      payload: { text: "점검 알림", caller_info: { source: "agent", agent_node: "eiaserinnys" } },
    });

    expect(result).toMatchObject({ inserted: false, conflict: false });
    expect(result.row).toBe(existing);
    // 기존 행을 그대로 돌려주고 저장된 해시와 payload는 건드리지 않는다.
    expect(result.row.payload_hash).toBe("hash-empty-agent-node");
    expect(calls.some((call) => call.text.includes("state = 'uncertain'"))).toBe(false);
  });

  it("still reports a conflict when any other payload field differs", async () => {
    const existing = deliveryRow({
      payload_hash: "hash-empty-agent-node",
      payload: { text: "점검 알림", caller_info: { source: "agent", agent_node: "" } },
      state: "queued",
    });
    const uncertain = {
      ...existing,
      state: "uncertain" as const,
      aggregate_state: "dead_letter" as const,
      dead_letter_reason: "delivery identity conflict",
    };
    const { sql } = createDeliverySql({ insert: [], existing, uncertain });
    const repository = new SessionDeliveryRepository(sql);

    const result = await repository.register({
      deliveryId: "haniel-inspection-1",
      targetSessionId: "target-1",
      relationKey: "user_message:target-1:haniel-inspection-1",
      completionId: "message:haniel-inspection-1",
      intent: "human_live_steer",
      source: "user_message",
      payloadHash: "hash-other-body",
      payload: { text: "다른 본문", caller_info: { source: "agent", agent_node: "eiaserinnys" } },
    });

    expect(result).toMatchObject({ inserted: false, conflict: true });
    expect(result.row.state).toBe("uncertain");
  });

  it("applies the same relaxation to runtime follow-up re-registration", async () => {
    const existing = deliveryRow({
      delivery_id: "followup-1",
      relation_key: "runtime_followup:target-1:key-1",
      completion_id: "completion-1",
      intent: "runtime_followup",
      payload_hash: "hash-empty-agent-node",
      payload: {
        followup_key: "key-1",
        followup_attempt: 1,
        caller_info: { source: "agent", agent_node: "" },
      },
      state: "queued",
    });
    const { sql, calls } = createDeliverySql({ insert: [], existing });
    const repository = new SessionDeliveryRepository(sql);

    const result = await repository.register({
      deliveryId: "followup-1",
      targetSessionId: "target-1",
      relationKey: "runtime_followup:target-1:key-1",
      completionId: "completion-1",
      intent: "runtime_followup",
      source: "claude",
      payloadHash: "hash-with-node-agent-node",
      payload: {
        followup_key: "key-1",
        followup_attempt: 1,
        caller_info: { source: "agent", agent_node: "eiaserinnys" },
      },
    });

    expect(result).toMatchObject({ inserted: false, conflict: false });
    expect(result.row).toBe(existing);
    expect(calls.some((call) => call.text.includes("state = 'uncertain'"))).toBe(false);
  });

  it("still reports a runtime follow-up conflict when the follow-up body differs", async () => {
    const existing = deliveryRow({
      delivery_id: "followup-1",
      relation_key: "runtime_followup:target-1:key-1",
      completion_id: "completion-1",
      intent: "runtime_followup",
      payload_hash: "hash-empty-agent-node",
      payload: {
        followup_key: "key-1",
        followup_attempt: 1,
        caller_info: { source: "agent", agent_node: "" },
      },
      state: "queued",
    });
    const uncertain = {
      ...existing,
      state: "uncertain" as const,
      aggregate_state: "dead_letter" as const,
      dead_letter_reason: "delivery identity conflict",
    };
    const { sql } = createDeliverySql({ insert: [], existing, uncertain });
    const repository = new SessionDeliveryRepository(sql);

    const result = await repository.register({
      deliveryId: "followup-1",
      targetSessionId: "target-1",
      relationKey: "runtime_followup:target-1:key-1",
      completionId: "completion-1",
      intent: "runtime_followup",
      source: "claude",
      payloadHash: "hash-other-body",
      payload: {
        followup_key: "key-1",
        followup_attempt: 2,
        caller_info: { source: "agent", agent_node: "eiaserinnys" },
      },
    });

    expect(result).toMatchObject({ inserted: false, conflict: true });
    expect(result.row.state).toBe("uncertain");
  });
});

function deliveryRow(overrides: Partial<SessionDeliveryRow> = {}): SessionDeliveryRow {
  return {
    delivery_id: "haniel-inspection-1",
    target_session_id: "target-1",
    source_session_id: null,
    relation_key: "user_message:target-1:haniel-inspection-1",
    completion_id: "message:haniel-inspection-1",
    intent: "human_live_steer",
    source: "user_message",
    producer_kind: null,
    producer_id: null,
    producer_terminal_revision: null,
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: "hash-1",
    payload: {},
    state: "pending",
    aggregate_state: "pending",
    created_at: new Date(),
    updated_at: new Date(),
    claimed_at: null,
    dispatching_at: null,
    attempt_token: null,
    attempt_expires_at: null,
    attempt_count: 0,
    next_attempt_at: new Date(),
    last_error: null,
    queued_at: null,
    delivered_at: null,
    consumed_at: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    target_receipt_id: null,
    target_receipt_at: null,
    consumed_reason: null,
    dead_letter_reason: null,
    dead_lettered_at: null,
    ...overrides,
  };
}

function createDeliverySql(input: {
  insert: SessionDeliveryRow[];
  existing?: SessionDeliveryRow;
  uncertain?: SessionDeliveryRow;
}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (text.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (text.includes("FROM session_delivery_relation_consumptions")) {
      return Promise.resolve([]);
    }
    if (text.includes("intent = 'runtime_followup' AND state = 'pending'")) {
      return Promise.resolve([]);
    }
    if (text.includes("FROM session_deliveries WHERE delivery_id = ?")) {
      return Promise.resolve(input.existing ? [input.existing] : []);
    }
    if (text.startsWith("UPDATE session_deliveries")
      && text.includes("state = 'uncertain'")) {
      return Promise.resolve(input.uncertain ? [input.uncertain] : []);
    }
    if (text.includes("INSERT INTO session_delivery_attempts")) {
      return Promise.resolve([]);
    }
    if (text.startsWith("INSERT INTO session_deliveries")) {
      return Promise.resolve(input.insert);
    }
    return Promise.resolve([]);
  });
  const sql = Object.assign(query, {
    begin: async <T>(callback: (transaction: SqlClient) => Promise<T>): Promise<T> =>
      await callback(sql as unknown as SqlClient),
    json: (value: unknown) => value,
  }) as unknown as SqlClient;
  return { sql, calls };
}
