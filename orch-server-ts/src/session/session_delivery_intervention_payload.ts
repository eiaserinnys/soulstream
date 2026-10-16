import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";

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
  const bindings = storedAttachmentBindings(row.payload.attachment_bindings);
  if (bindings === null) {
    return {
      ok: false,
      message: `Delivery ${row.delivery_id} has invalid attachment bindings`,
    };
  }
  const parsed = intervenePayload(row.target_session_id, {
    text: row.payload.text,
    user: row.payload.user,
    caller_info: row.payload.caller_info,
    ...(row.payload.attachment_paths === null
      ? {}
      : { attachment_paths: row.payload.attachment_paths }),
    ...(row.payload.attachment_ids == null
      ? {}
      : { attachment_ids: row.payload.attachment_ids }),
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
  // Stored bindings are trusted server output, so they bypass the request-body check.
  if (parsed.ok && bindings.length > 0) parsed.value.attachment_bindings = bindings;
  return parsed;
}

function storedAttachmentBindings(value: unknown): AttachmentPathBinding[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const bindings: AttachmentPathBinding[] = [];
  for (const item of value) {
    if (
      typeof item !== "object" || item === null
      || typeof item.attachment_id !== "string" || item.attachment_id.length === 0
      || typeof item.node_id !== "string" || item.node_id.length === 0
      || typeof item.path !== "string"
    ) return null;
    bindings.push({ attachment_id: item.attachment_id, node_id: item.node_id, path: item.path });
  }
  return bindings;
}
