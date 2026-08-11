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
    await sql`
      SELECT session_update(
        ${envelope.session_id},
        ${["status", "termination_reason", "termination_detail", "review_state"]},
        ${["running", null, null, effect.review_state]},
        ${new Date(effect.updated_at)}
      )
      WHERE NOT EXISTS (
        SELECT 1
        FROM sessions
        WHERE session_id = ${envelope.session_id}
          AND status IN ('completed', 'error')
      )
    `;
    return;
  }
  if (effect.kind === "terminal_transition") {
    await applyTerminalTransition(sql, envelope.session_id, effect);
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
  effect: Extract<EventSessionEffect, { kind: "terminal_transition" }>,
): Promise<void> {
  await sql`
    SELECT session_update(
      ${sessionId},
      ${["status", "termination_reason", "termination_detail", "review_state"]},
      ${[
        effect.status,
        effect.termination_reason,
        effect.termination_detail,
        effect.review_state,
      ]},
      ${new Date(effect.updated_at)}
    )
  `;
}
