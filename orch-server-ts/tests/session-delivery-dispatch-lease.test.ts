/**
 * card #1380 — 발송 중(dispatching) 전달 시도가 claim의 15초 시한을 그대로 쓰면
 * 만료 sweep이 진행 중인 발송을 pending으로 되돌리고, 뒤따르는 markQueued가
 * 토큰 CAS를 잃는다. beginDispatch는 dispatching으로 옮길 때 attempt_expires_at을
 * dispatchLease(기본 120초)로 다시 쓴다. claim의 15초와 만료 sweep의 되돌림 규칙은
 * 그대로다.
 */
import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow, SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionDeliveryRepository } from
  "../src/control_plane/repositories/session_delivery_repository.js";

describe("session delivery dispatching attempt expiry", () => {
  it("extends the attempt expiry to the configured dispatching window", async () => {
    const { sql, calls } = createSql(() => [deliveryRow()]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.beginDispatch("delivery-1", "token-1"))
      .resolves.toMatchObject({ delivery_id: "delivery-1" });

    const call = calls[0]!;
    expect(call.text).toContain("state = 'dispatching'");
    expect(call.text).toContain(
      "attempt_expires_at = NOW() + (?::double precision * INTERVAL '1 millisecond')",
    );
    expect(call.values).toContain(120_000);
    // 만료 전 claimed만 통과시키는 조건은 그대로 둔다.
    expect(call.text).toContain("delivery.state = 'claimed'");
    expect(call.text).toContain("delivery.attempt_expires_at > NOW()");
  });

  it("accepts a custom dispatching window like the claim TTL", async () => {
    const { sql, calls } = createSql(() => [deliveryRow()]);
    const repository = new SessionDeliveryRepository(sql);

    await repository.beginDispatch("delivery-1", "token-1", 5_000);

    expect(calls[0]!.values).toContain(5_000);
    expect(calls[0]!.values).not.toContain(120_000);
  });

  it("keeps the claim step on its 15-second attempt TTL", async () => {
    const { sql, calls } = createSql(() => [deliveryRow()]);
    const repository = new SessionDeliveryRepository(sql);

    await repository.claim("delivery-1", "token-1");

    expect(calls[0]!.text).toContain("SET state = 'claimed'");
    expect(calls[0]!.values).toContain(15_000);
  });
});

function deliveryRow(): SessionDeliveryRow {
  return {
    delivery_id: "delivery-1",
    target_session_id: "target-1",
    source_session_id: null,
    relation_key: "user_message:target-1:delivery-1",
    completion_id: null,
    intent: "human_live_steer",
    source: "browser",
    producer_kind: null,
    producer_id: null,
    producer_terminal_revision: null,
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: "hash-1",
    payload: {},
    state: "dispatching",
    aggregate_state: "pending",
    created_at: new Date(),
    updated_at: new Date(),
    claimed_at: new Date(),
    dispatching_at: new Date(),
    attempt_token: "token-1",
    attempt_expires_at: new Date(),
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
  };
}

function createSql(resultFor: (text: string) => unknown[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(resultFor(text));
  }) as unknown as SqlClient;
  return { sql, calls };
}
