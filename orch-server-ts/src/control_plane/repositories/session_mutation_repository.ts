import { sanitizePgText } from "../../node/pg_text_sanitizer.js";
import type { SqlClient } from "../control_plane_types.js";
import type { SessionDeletionPort } from "../../session/session_deletion_service.js";
import { runIdempotentSessionMutation } from "./idempotent_session_mutation.js";

export type SessionTransitionFields = {
  status?: string;
  prompt?: string;
  clientId?: string | null;
  wasRunningAtShutdown?: boolean;
  lastReadEventId?: number;
  terminationReason?: string | null;
  terminationDetail?: string | null;
  reviewState?: string;
};

export type RegisterSessionMutation = {
  idempotencyKey: string;
  sessionId: string;
  nodeId: string;
  agentId: string | null;
  claudeSessionId: string | null;
  sessionType: string;
  prompt: string;
  clientId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  modelPreset?: string | null;
  model?: string | null;
  notifyCompletion?: boolean | null;
  reviewRequired?: boolean;
  reviewState?: string;
};

export class SessionMutationRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly sessionDeletion?: SessionDeletionPort,
  ) {}

  registerSession(input: RegisterSessionMutation): Promise<{ ok: true }> {
    const sanitizedInput = {
      ...input,
      prompt: sanitizePgText(input.prompt),
    };
    return this.idempotent("register_session", sanitizedInput, async (sql) => {
      await sql`
        SELECT session_register_with_model_preset(
          ${sanitizedInput.sessionId}, ${sanitizedInput.nodeId},
          ${sanitizedInput.agentId}, ${sanitizedInput.claudeSessionId},
          ${sanitizedInput.sessionType}, ${sanitizedInput.prompt},
          ${sanitizedInput.clientId}, ${sanitizedInput.status},
          ${sanitizedInput.createdAt}, ${sanitizedInput.updatedAt},
          ${sanitizedInput.callerSessionId}, ${sanitizedInput.notifyCompletion ?? true},
          ${sanitizedInput.reviewRequired ?? false},
          ${sanitizedInput.reviewState ?? "not_required"},
          ${sanitizedInput.predecessorSessionId},
          ${sanitizedInput.modelPreset ?? null}, ${sanitizedInput.model ?? null}
        )
      `;
      return { ok: true } as const;
    });
  }

  async transitionSession(input: {
    idempotencyKey: string;
    sessionId: string;
    fields: SessionTransitionFields;
    updatedAt: Date;
  }): Promise<{ ok: true }> {
    const sanitizedInput = {
      ...input,
      fields: {
        ...input.fields,
        ...(input.fields.prompt === undefined
          ? {}
          : { prompt: sanitizePgText(input.fields.prompt) }),
      },
    };
    assertTransitionFields(sanitizedInput.fields);
    return await this.idempotent("transition_session", sanitizedInput, async (sql) => {
      const [columns, values] = transitionColumns(sanitizedInput.fields);
      if (columns.length === 0) throw hostError(422, "transition_session fields must not be empty");
      await sql`SELECT session_update(
        ${sanitizedInput.sessionId}, ${columns}, ${values}, ${sanitizedInput.updatedAt}
      )`;
      return { ok: true } as const;
    });
  }

  renameSession(input: {
    idempotencyKey: string;
    sessionId: string;
    displayName: string | null;
  }): Promise<{ ok: true }> {
    const sanitizedInput = {
      ...input,
      displayName: input.displayName === null ? null : sanitizePgText(input.displayName),
    };
    return this.idempotent("rename_session", sanitizedInput, async (sql) => {
      await sql`SELECT session_rename(
        ${sanitizedInput.sessionId}, ${sanitizedInput.displayName}
      )`;
      return { ok: true } as const;
    });
  }

  deleteSession(input: {
    idempotencyKey: string;
    sessionId: string;
  }): Promise<{ ok: true }> {
    return this.idempotent("delete_session", input, async () => {
      if (!this.sessionDeletion) throw hostError(500, "session deletion service is required");
      await this.sessionDeletion.deleteSession(input.sessionId);
      return { ok: true } as const;
    });
  }

  acknowledgeReview(input: {
    idempotencyKey: string;
    sessionId: string;
    updatedAt: Date;
  }): Promise<string> {
    return this.idempotent("acknowledge_review", input, async (sql) => {
      const rows = await sql<Array<{ outcome: string }>>`
        SELECT session_acknowledge_review(${input.sessionId}, ${input.updatedAt}) AS outcome
      `;
      return String(rows[0]?.outcome ?? "not_found");
    });
  }

  async reconcileNodeDisconnected(nodeId: string, updatedAt: Date): Promise<number> {
    const rows = await this.sql<Array<{ count: number }>>`
      WITH changed AS (
        UPDATE sessions
        SET status = 'interrupted', was_running_at_shutdown = TRUE,
            termination_reason = 'killed', termination_detail = 'node_disconnect',
            review_state = CASE
              WHEN review_required THEN 'needs_review'
              ELSE 'acknowledged'
            END,
            updated_at = ${updatedAt}
        WHERE node_id = ${nodeId} AND status = 'running'
        RETURNING 1
      ) SELECT COUNT(*)::int AS count FROM changed
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async reconcileNodeStartup(
    nodeId: string,
    runningSessionIds: string[],
    updatedAt: Date,
  ): Promise<{ interrupted: number; restored: number }> {
    return await this.sql.begin(async (sql) => {
      const interruptedRows = await sql<Array<{ count: number }>>`
        WITH changed AS (
          UPDATE sessions
          SET status = 'interrupted', was_running_at_shutdown = TRUE,
              termination_reason = 'killed', termination_detail = 'startup_reconciliation',
              review_state = CASE
                WHEN review_required THEN 'needs_review'
                ELSE 'acknowledged'
              END,
              updated_at = ${updatedAt}
          WHERE node_id = ${nodeId} AND status = 'running'
            AND NOT (session_id = ANY(${sql.array(runningSessionIds)}::text[]))
          RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM changed
      `;
      const restoredRows = await sql<Array<{ count: number }>>`
        WITH changed AS (
          UPDATE sessions
          SET status = 'running', was_running_at_shutdown = FALSE,
              termination_reason = NULL, termination_detail = NULL,
              review_state = 'not_required',
              updated_at = ${updatedAt}
          WHERE node_id = ${nodeId}
            AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
            AND status <> 'running'
          RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM changed
      `;
      return {
        interrupted: Number(interruptedRows[0]?.count ?? 0),
        restored: Number(restoredRows[0]?.count ?? 0),
      };
    });
  }

  private async idempotent<T>(
    operation: string,
    input: { idempotencyKey: string; sessionId: string },
    mutate: (sql: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await runIdempotentSessionMutation(this.sql, operation, input, mutate);
  }
}

const TRANSITION_FIELD_KEYS = new Set<keyof SessionTransitionFields>([
  "status",
  "prompt",
  "clientId",
  "wasRunningAtShutdown",
  "lastReadEventId",
  "terminationReason",
  "terminationDetail",
  "reviewState",
]);

function assertTransitionFields(fields: SessionTransitionFields): void {
  const unknown = Object.keys(fields).filter(
    (key) => !TRANSITION_FIELD_KEYS.has(key as keyof SessionTransitionFields),
  );
  if (unknown.length > 0) {
    throw hostError(422, `transition_session fields are not allowed: ${unknown.join(", ")}`);
  }
}

function transitionColumns(fields: SessionTransitionFields): [string[], Array<string | null>] {
  const values: Array<[keyof SessionTransitionFields, string, (value: never) => string | null]> = [
    ["status", "status", String],
    ["prompt", "prompt", String],
    ["clientId", "client_id", (value) => value === null ? null : String(value)],
    ["wasRunningAtShutdown", "was_running_at_shutdown", String],
    ["lastReadEventId", "last_read_event_id", String],
    ["terminationReason", "termination_reason", (value) => value === null ? null : String(value)],
    ["terminationDetail", "termination_detail", (value) => value === null ? null : String(value)],
    ["reviewState", "review_state", String],
  ];
  const selected = values.filter(([key]) => fields[key] !== undefined);
  return [
    selected.map(([, column]) => column),
    selected.map(([key, , serialize]) => serialize(fields[key] as never)),
  ];
}

function hostError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
