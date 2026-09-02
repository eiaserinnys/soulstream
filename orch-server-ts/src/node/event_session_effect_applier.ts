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
  if (effect.kind === "execution_registration") {
    return await applyExecutionRegistration(
      sql,
      envelope.session_id,
      effect,
    );
  }
  if (effect.kind === "execution_acquire") {
    const application = await applyExecutionRegistration(
      sql,
      envelope.session_id,
      effect,
    );
    return {
      ...application,
      canonicalExecutionOwnership: application.canonicalExecutionRegistration
        ? {
            ownership_generation: 1,
            owner_kind: effect.owner_kind,
            manifest_id: effect.manifest_id,
            runtime_env_identity: effect.runtime_env_identity,
            registration_id:
              application.canonicalExecutionRegistration.registration_id,
            pid: effect.pid,
            start_identity: effect.start_identity,
            execution_command_id:
              application.canonicalExecutionRegistration.execution_command_id,
            phase: "active",
            failure_reason: null,
          }
        : null,
    };
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

type CanonicalRegistrationRow = CanonicalTransitionRow & {
  execution_registration_id: string | null;
  execution_command_id: string | null;
};

async function applyExecutionRegistration(
  sql: EventIngressQuerySql,
  sessionId: string,
  effect: Extract<
    EventSessionEffect,
    { kind: "execution_registration" | "execution_acquire" }
  >,
): Promise<EventSessionEffectApplication> {
  const rows = await sql<CanonicalRegistrationRow[]>`
    SELECT * FROM session_record_execution_registration(
      ${sessionId},
      ${effect.registration_id},
      ${effect.execution_command_id},
      ${effect.review_state},
      ${effect.expected_terminal_event_id ?? null},
      ${effect.expected_terminal_event_id !== undefined},
      ${new Date(effect.updated_at)}
    )
  `;
  const application = canonicalTransitionApplication(rows, "execution registration");
  const row = rows[0]!;
  if (
    (row.execution_registration_id === null)
    !== (row.execution_command_id === null)
  ) {
    throw new Error(
      "execution registration transition returned a partial canonical registration",
    );
  }
  return {
    ...application,
    canonicalExecutionRegistration: row.execution_registration_id === null
      ? null
      : {
          registration_id: row.execution_registration_id,
          execution_command_id: row.execution_command_id!,
        },
  };
}

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
  return {
    ...canonicalTransitionApplication(rows, "terminal"),
    canonicalExecutionRegistration: null,
  };
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
