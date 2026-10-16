import { describe, expect, it } from "vitest";
import type { SessionDeliveryRow } from "../src/control_plane/control_plane_types.js";
import { intervenePayload, parseAttachmentIds } from
  "../src/session/session_action_command_payloads.js";
import { sessionDeliveryInterventionPayload } from
  "../src/session/session_delivery_intervention_payload.js";

function storedRow(payload: Record<string, unknown>): SessionDeliveryRow {
  return {
    delivery_id: "delivery-stored",
    target_session_id: "session-1",
    relation_key: "relation-stored",
    completion_id: "completion-stored",
    intent: "human_live_steer",
    source: "user_message",
    producer_terminal_revision: null,
    parent_delivery_id: null,
    caller_turn_id: null,
    created_at: new Date("2026-10-16T00:00:00.000Z"),
    payload: { text: "다시 보냅니다", user: "operator", context: null, ...payload },
  } as unknown as SessionDeliveryRow;
}

const storedBinding = { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" };

describe("sessionDeliveryInterventionPayload", () => {
  it("projects every persisted delivery field into the existing intervene payload", () => {
    const row: SessionDeliveryRow = {
      delivery_id: "delivery-1",
      target_session_id: "session-1",
      source_session_id: "source-session",
      relation_key: "relation-1",
      completion_id: "completion-1",
      intent: "durable_next_turn",
      source: "card_change",
      producer_kind: "card_execution",
      producer_id: "operation-1",
      producer_terminal_revision: "revision-1",
      parent_delivery_id: "parent-1",
      caller_turn_id: "turn-1",
      payload_hash: "hash",
      payload: {
        text: "계속 진행해 주세요",
        user: "서소영",
        caller_info: { source: "browser", session_id: "caller-1" },
        attachment_paths: ["/workspace/file.txt"],
        context: [{ type: "text", text: "요청 맥락" }],
      },
      state: "pending",
      aggregate_state: "pending",
      created_at: new Date("2026-10-08T00:00:00.000Z"),
      updated_at: new Date("2026-10-08T00:00:00.000Z"),
      claimed_at: null,
      dispatching_at: null,
      attempt_token: null,
      attempt_expires_at: null,
      attempt_count: 0,
      next_attempt_at: new Date("2026-10-08T00:00:00.000Z"),
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

    const parsed = sessionDeliveryInterventionPayload(row, "node-ready:node-1:connection-1");

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        type: "intervene",
        agentSessionId: "session-1",
        text: "계속 진행해 주세요",
        user: "서소영",
        caller_info: { source: "browser", session_id: "caller-1" },
        attachment_paths: ["/workspace/file.txt"],
        extra_context_items: [{ type: "text", text: "요청 맥락" }],
        delivery_id: "delivery-1",
        delivery_intent: "durable_next_turn",
        source: "card_change",
        completion_id: "completion-1",
        relation_key: "relation-1",
        producer_terminal_revision: "revision-1",
        parent_delivery_id: "parent-1",
        caller_turn_id: "turn-1",
        created_at: "2026-10-08T00:00:00.000Z",
        delivery_attempt_token: "node-ready:node-1:connection-1",
      },
    });
  });

  it("rejects rows without the saved delivery identity", () => {
    const row = {
      delivery_id: "delivery-2",
      target_session_id: null,
      completion_id: "completion-2",
    } as SessionDeliveryRow;

    expect(sessionDeliveryInterventionPayload(row, "attempt")).toEqual({
      ok: false,
      message: "Delivery delivery-2 has incomplete identity",
    });
  });
});

describe("stored attachment ids on redelivery", () => {
  it("restores the saved ids and bindings without another lookup", () => {
    const parsed = sessionDeliveryInterventionPayload(storedRow({
      attachment_paths: ["/tmp/a.png"],
      attachment_ids: ["att-a"],
      attachment_bindings: [storedBinding],
    }), "attempt");

    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.attachment_paths).toEqual(["/tmp/a.png"]);
    expect(parsed.value.attachment_ids).toEqual(["att-a"]);
    expect(parsed.value.attachment_bindings).toEqual([storedBinding]);
  });

  it("keeps rows saved before attachment ids existed unchanged", () => {
    const parsed = sessionDeliveryInterventionPayload(
      storedRow({ attachment_paths: ["/tmp/legacy.txt"] }),
      "attempt",
    );

    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty("attachment_ids");
    expect(parsed.value).not.toHaveProperty("attachment_bindings");
  });

  it("rejects a saved row whose bindings are malformed", () => {
    expect(sessionDeliveryInterventionPayload(
      storedRow({ attachment_ids: ["att-a"], attachment_bindings: [{ attachment_id: "att-a" }] }),
      "attempt",
    )).toEqual({
      ok: false,
      message: "Delivery delivery-stored has invalid attachment bindings",
    });
  });
});

describe("intervene attachment ids parsing", () => {
  it("accepts an empty text with ids only", () => {
    const parsed = intervenePayload("session-1", { text: "", attachment_ids: ["att-a"] });

    expect(parsed).toMatchObject({
      ok: true,
      value: { type: "intervene", text: "", attachment_ids: ["att-a"] },
    });
  });

  it("still rejects a non-string text", () => {
    expect(intervenePayload("session-1", { text: 1, attachment_ids: ["att-a"] })).toEqual({
      ok: false,
      message: "text is required",
    });
  });

  it("dedupes ids in first-seen order and accepts both spellings when equal", () => {
    expect(parseAttachmentIds({ attachment_ids: ["b", "a", "b"] }))
      .toEqual({ ok: true, value: ["b", "a"] });
    expect(parseAttachmentIds({ attachmentIds: ["a", "b"], attachment_ids: ["a", "b", "a"] }))
      .toEqual({ ok: true, value: ["a", "b"] });
    expect(parseAttachmentIds({})).toEqual({ ok: true, value: undefined });
  });

  it("rejects differing spellings, bad elements, and request bindings", () => {
    expect(parseAttachmentIds({ attachmentIds: ["a"], attachment_ids: ["b"] }))
      .toMatchObject({ ok: false });
    for (const attachment_ids of [[""], [1], "a", null]) {
      expect(parseAttachmentIds({ attachment_ids })).toMatchObject({ ok: false });
    }
    const body = { text: "x", attachment_ids: ["a"], attachment_bindings: [storedBinding] };
    const before = structuredClone(body);
    expect(intervenePayload("session-1", body)).toMatchObject({ ok: false });
    expect(body).toEqual(before);
  });
});
