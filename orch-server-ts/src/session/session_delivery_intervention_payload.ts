import type { SessionDeliveryRow } from "../control_plane/control_plane_types.js";
import {
  intervenePayload,
  type InterveneNodeCommandPayload,
  type ParseResult,
} from "./session_action_command_payloads.js";

export function sessionDeliveryInterventionPayload(
  row: SessionDeliveryRow,
  attemptToken?: string,
): ParseResult<InterveneNodeCommandPayload> {
  if (row.target_session_id === null || row.completion_id === null) {
    return {
      ok: false,
      message: `Delivery ${row.delivery_id} has incomplete identity`,
    };
  }
  return intervenePayload(row.target_session_id, {
    text: row.payload.text,
    user: row.payload.user,
    caller_info: row.payload.caller_info,
    ...(row.payload.attachment_paths === null
      ? {}
      : { attachment_paths: row.payload.attachment_paths }),
    ...(row.payload.context === null
      ? {}
      : { context_items: row.payload.context }),
    delivery_id: row.delivery_id,
    delivery_intent: row.intent,
    source: row.source,
    completion_id: row.completion_id,
    relation_key: row.relation_key,
    producer_terminal_revision: row.producer_terminal_revision,
    parent_delivery_id: row.parent_delivery_id,
    caller_turn_id: row.caller_turn_id,
    created_at: row.created_at.toISOString(),
    ...(attemptToken === undefined
      ? {}
      : { delivery_attempt_token: attemptToken }),
  });
}
