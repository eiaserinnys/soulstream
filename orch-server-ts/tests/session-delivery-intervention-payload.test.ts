import { describe, expect, it } from "vitest";
import type { SessionDeliveryRow } from "../src/control_plane/control_plane_types.js";
import { sessionDeliveryInterventionPayload } from
  "../src/session/session_delivery_intervention_payload.js";

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
