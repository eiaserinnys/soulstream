import type {
  EventIngressQuerySql,
  EventSessionEffectApplier,
} from "./event_ingress_repository.js";
import type { EventSessionEffect } from "./event_ingress_types.js";

export const applyEventSessionEffect: EventSessionEffectApplier = async (
  sql,
  input,
) => {
  const { effect, envelope } = input;
  if (effect.kind === "last_message") {
    await sql`
      SELECT session_update_last_message(
        ${envelope.session_id},
        ${JSON.stringify(effect.last_message)},
        ${new Date(effect.updated_at)}
      )
    `;
    return;
  }
  if (effect.kind === "set_backend_session_id") {
    await sql`SELECT session_set_claude_id(${envelope.session_id}, ${effect.backend_session_id})`;
    return;
  }
  if (effect.kind === "running_transition") {
    await sql`SELECT session_apply_running_transition(
      ${envelope.session_id},
      ${effect.review_state},
      ${effect.expected_terminal_event_id ?? null},
      ${effect.expected_terminal_event_id !== undefined},
      ${new Date(effect.updated_at)}
    )`;
    return;
  }
  if (effect.kind === "terminal_transition") {
    await applyTerminalTransition(sql, envelope.session_id, input.eventId, effect);
    return;
  }
  await sql`
    SELECT session_apply_metadata_entry(
      ${envelope.session_id},
      ${JSON.stringify(effect.entry)},
      ${effect.replace_existing_type ?? null},
      ${new Date(effect.updated_at)}
    )
  `;
};

async function applyTerminalTransition(
  sql: EventIngressQuerySql,
  sessionId: string,
  eventId: number,
  effect: Extract<EventSessionEffect, { kind: "terminal_transition" }>,
): Promise<void> {
  await sql`
    SELECT session_apply_terminal_transition(
      ${sessionId},
      ${effect.status},
      ${effect.termination_reason},
      ${effect.termination_detail},
      ${effect.review_state},
      ${effect.last_assistant_text ?? null},
      ${eventId},
      ${new Date(effect.updated_at)}
    )
  `;
}
