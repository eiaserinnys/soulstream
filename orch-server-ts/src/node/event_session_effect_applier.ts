import type {
  EventIngressQuerySql,
  EventSessionEffectApplier,
} from "./event_ingress_repository.js";
import type {
  EventCanonicalSessionProjection,
  EventSessionEffect,
  EventSessionEffectApplication,
} from "./event_ingress_types.js";

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
    return appliedWithoutCanonicalProjection();
  }
  if (effect.kind === "set_backend_session_id") {
    await sql`SELECT session_set_claude_id(${envelope.session_id}, ${effect.backend_session_id})`;
    return appliedWithoutCanonicalProjection();
  }
  if (effect.kind === "rotate_backend_session_id") {
    await sql`
      SELECT session_rotate_claude_id(
        ${envelope.session_id},
        ${effect.expected_backend_session_id},
        ${effect.backend_session_id}
      )
    `;
    return appliedWithoutCanonicalProjection();
  }
  if (effect.kind === "running_transition") {
    const rows = await sql<CanonicalTransitionRow[]>`SELECT * FROM session_apply_running_transition(
      ${envelope.session_id},
      ${effect.review_state},
      ${effect.expected_terminal_event_id ?? null},
      ${effect.expected_terminal_event_id !== undefined},
      ${new Date(effect.updated_at)}
    )`;
    return canonicalTransitionApplication(rows, "running");
  }
  if (effect.kind === "execution_reserve") {
    const rows = await sql<CanonicalTransitionRow[]>`
      SELECT * FROM session_reserve_execution_ownership(
        ${envelope.session_id},
        ${effect.ownership_generation},
        ${effect.owner_kind},
        ${effect.manifest_id},
        ${new Date(effect.updated_at)}
      )
    `;
    return canonicalTransitionApplication(rows, "execution reserve");
  }
  if (effect.kind === "execution_prove") {
    const rows = await sql<CanonicalTransitionRow[]>`
      WITH application AS (
        SELECT session_prove_execution_ownership(
          ${envelope.session_id},
          ${effect.ownership_generation},
          ${effect.registration_id},
          ${effect.pid},
          ${effect.start_identity},
          ${effect.execution_command_id},
          ${new Date(effect.updated_at)}
        ) AS applied
      )
      SELECT application.applied, session.status, session.termination_reason,
             session.termination_detail, session.review_state,
             session.last_assistant_text, session.termination_event_id,
             session.updated_at, session.last_event_id
      FROM application
      JOIN sessions AS session ON session.session_id = ${envelope.session_id}
    `;
    return canonicalTransitionApplication(rows, "execution proof");
  }
  if (effect.kind === "execution_adopt_reserve") {
    const rows = await sql<CanonicalTransitionRow[]>`
      SELECT * FROM session_reserve_execution_adoption(
        ${envelope.session_id},
        ${effect.ownership_generation},
        ${effect.manifest_id},
        ${effect.previous_registration_id},
        ${effect.pid},
        ${effect.start_identity},
        ${effect.execution_command_id},
        ${new Date(effect.updated_at)}
      )
    `;
    return canonicalTransitionApplication(rows, "execution adoption reserve");
  }
  if (effect.kind === "execution_activate") {
    const rows = await sql<CanonicalTransitionRow[]>`
      SELECT * FROM session_activate_execution_ownership(
        ${envelope.session_id},
        ${effect.ownership_generation},
        ${effect.review_state},
        ${effect.expected_terminal_event_id ?? null},
        ${effect.expected_terminal_event_id !== undefined},
        ${new Date(effect.updated_at)}
      )
    `;
    return canonicalTransitionApplication(rows, "execution activation");
  }
  if (effect.kind === "execution_fail") {
    const rows = await sql<CanonicalTransitionRow[]>`
      WITH application AS (
        SELECT session_fail_execution_ownership(
          ${envelope.session_id},
          ${effect.ownership_generation},
          ${effect.failure_reason},
          ${new Date(effect.updated_at)}
        ) AS applied
      )
      SELECT application.applied, session.status, session.termination_reason,
             session.termination_detail, session.review_state,
             session.last_assistant_text, session.termination_event_id,
             session.updated_at, session.last_event_id
      FROM application
      JOIN sessions AS session ON session.session_id = ${envelope.session_id}
    `;
    return canonicalTransitionApplication(rows, "execution failure");
  }
  if (effect.kind === "execution_backfill") {
    const rows = await sql<CanonicalTransitionRow[]>`
      WITH migration AS (
        SELECT session_backfill_execution_ownership(
          ${envelope.session_id},
          ${effect.first_manifest_id},
          ${effect.first_registration_id},
          ${effect.first_pid},
          ${effect.first_start_identity},
          ${effect.first_execution_command_id},
          ${new Date(effect.first_observed_at)},
          ${effect.second_manifest_id},
          ${effect.second_registration_id},
          ${effect.second_pid},
          ${effect.second_start_identity},
          ${effect.second_execution_command_id},
          ${new Date(effect.second_observed_at)},
          ${effect.evidence_hash},
          ${effect.minimum_lease_interval_ms},
          ${effect.probe_only}
        ) AS action
      )
      SELECT migration.action IN ('backfilled', 'already_owned') AS applied,
             session.status, session.termination_reason,
             session.termination_detail, session.review_state,
             session.last_assistant_text, session.termination_event_id,
             session.updated_at, session.last_event_id
      FROM migration
      JOIN sessions AS session ON session.session_id = ${envelope.session_id}
    `;
    return canonicalTransitionApplication(rows, "execution backfill");
  }
  if (effect.kind === "runner_terminal_fact") {
    const rows = await sql<CanonicalTransitionRow[]>`
      SELECT * FROM session_project_runner_terminal_fact(
        ${envelope.session_id},
        ${effect.ownership_generation},
        ${effect.execution_command_id},
        ${effect.runner_fact},
        ${effect.termination_detail},
        ${effect.review_state},
        ${effect.last_assistant_text ?? null},
        ${input.eventId},
        ${new Date(effect.updated_at)}
      )
    `;
    return canonicalTransitionApplication(rows, "runner terminal fact");
  }
  if (effect.kind === "recovered_runner_terminal_fact") {
    const rows = await sql<CanonicalTransitionRow[]>`
      SELECT * FROM session_project_recovered_runner_terminal_fact(
        ${envelope.session_id},
        ${effect.manifest_id},
        ${effect.registration_id},
        ${effect.pid},
        ${effect.start_identity},
        ${effect.execution_command_id},
        ${effect.runner_fact},
        ${effect.termination_detail},
        ${effect.review_state},
        ${effect.last_assistant_text ?? null},
        ${input.eventId},
        ${new Date(effect.updated_at)}
      )
    `;
    return canonicalTransitionApplication(rows, "recovered runner terminal fact");
  }
  if (effect.kind === "terminal_transition") {
    return await applyTerminalTransition(sql, envelope.session_id, input.eventId, effect);
  }
  await sql`
    SELECT session_apply_metadata_entry(
      ${envelope.session_id},
      ${JSON.stringify(effect.entry)},
      ${effect.replace_existing_type ?? null},
      ${new Date(effect.updated_at)}
    )
  `;
  return appliedWithoutCanonicalProjection();
};

type CanonicalTransitionRow = {
  applied: boolean;
  status: string;
  termination_reason: string | null;
  termination_detail: string | null;
  review_state: string;
  last_assistant_text: string | null;
  termination_event_id: number | null;
  updated_at: Date | string;
  last_event_id: number | null;
};

async function applyTerminalTransition(
  sql: EventIngressQuerySql,
  sessionId: string,
  eventId: number,
  effect: Extract<EventSessionEffect, { kind: "terminal_transition" }>,
): Promise<EventSessionEffectApplication> {
  const rows = await sql<CanonicalTransitionRow[]>`
    SELECT * FROM session_apply_terminal_transition(
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
  return canonicalTransitionApplication(rows, "terminal");
}

function canonicalTransitionApplication(
  rows: CanonicalTransitionRow[],
  transition: string,
): EventSessionEffectApplication {
  const row = rows[0];
  if (!row || rows.length !== 1) {
    throw new Error(`${transition} transition did not return one canonical session row`);
  }
  if (typeof row.applied !== "boolean") {
    throw new Error(`${transition} transition returned an invalid applied result`);
  }
  return {
    applied: row.applied,
    canonicalSession: canonicalProjection(row, transition),
  };
}

function canonicalProjection(
  row: CanonicalTransitionRow,
  transition: string,
): EventCanonicalSessionProjection {
  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at.toISOString()
    : row.updated_at;
  if (typeof updatedAt !== "string" || !Number.isFinite(new Date(updatedAt).getTime())) {
    throw new Error(`${transition} transition returned an invalid canonical updated_at`);
  }
  return {
    status: row.status,
    termination_reason: row.termination_reason,
    termination_detail: row.termination_detail,
    review_state: row.review_state,
    last_assistant_text: row.last_assistant_text,
    termination_event_id: row.termination_event_id,
    updated_at: updatedAt,
    last_event_id: row.last_event_id,
  };
}

function appliedWithoutCanonicalProjection(): EventSessionEffectApplication {
  return { applied: true, canonicalSession: null };
}
