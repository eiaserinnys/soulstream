import { createHash } from "node:crypto";

import type { SqlClient } from "../control_plane_types.js";

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

type MutationReceipt = {
  operation: string;
  session_id: string;
  request_hash: string;
  result_json: unknown;
};

export class SessionMutationRepository {
  constructor(private readonly sql: SqlClient) {}

  registerSession(input: RegisterSessionMutation): Promise<{ ok: true }> {
    return this.idempotent("register_session", input, async (sql) => {
      await sql`
        SELECT session_register_with_model_preset(
          ${input.sessionId}, ${input.nodeId}, ${input.agentId}, ${input.claudeSessionId},
          ${input.sessionType}, ${input.prompt}, ${input.clientId}, ${input.status},
          ${input.createdAt}, ${input.updatedAt}, ${input.callerSessionId},
          ${input.notifyCompletion ?? true}, ${input.reviewRequired ?? false},
          ${input.reviewState ?? "not_required"}, ${input.predecessorSessionId},
          ${input.modelPreset ?? null}, ${input.model ?? null}
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
    assertTransitionFields(input.fields);
    return await this.idempotent("transition_session", input, async (sql) => {
      const [columns, values] = transitionColumns(input.fields);
      if (columns.length === 0) throw hostError(422, "transition_session fields must not be empty");
      await sql`SELECT session_update(${input.sessionId}, ${columns}, ${values}, ${input.updatedAt})`;
      return { ok: true } as const;
    });
  }

  renameSession(input: {
    idempotencyKey: string;
    sessionId: string;
    displayName: string | null;
  }): Promise<{ ok: true }> {
    return this.idempotent("rename_session", input, async (sql) => {
      await sql`SELECT session_rename(${input.sessionId}, ${input.displayName})`;
      return { ok: true } as const;
    });
  }

  deleteSession(input: {
    idempotencyKey: string;
    sessionId: string;
  }): Promise<{ ok: true }> {
    return this.idempotent("delete_session", input, async (sql) => {
      await sql`SELECT session_delete(${input.sessionId})`;
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
    if (!input.idempotencyKey) throw hostError(422, "idempotencyKey is required");
    // Transport retries may reconstruct operational timestamps. The key owns the
    // original committed time; semantic fields must still match exactly.
    const requestHash = createHash("sha256")
      .update(JSON.stringify(input, (key, value) =>
        key === "createdAt" || key === "updatedAt" ? undefined : value))
      .digest("hex");
    const result = await this.sql.begin(async (sql) => {
      const transaction = sql as unknown as SqlClient;
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`;
      const receipts = await transaction<MutationReceipt[]>`
        SELECT operation, session_id, request_hash, result_json
        FROM session_mutation_receipts
        WHERE idempotency_key = ${input.idempotencyKey}
        FOR UPDATE
      `;
      const receipt = receipts[0];
      if (receipt) {
        if (
          receipt.operation !== operation
          || receipt.session_id !== input.sessionId
          || receipt.request_hash !== requestHash
        ) {
          throw hostError(409, `idempotency key conflict: ${input.idempotencyKey}`);
        }
        return receipt.result_json as T;
      }
      const result = await mutate(transaction);
      await transaction`
        INSERT INTO session_mutation_receipts (
          idempotency_key, operation, session_id, request_hash, result_json
        ) VALUES (
          ${input.idempotencyKey}, ${operation}, ${input.sessionId}, ${requestHash},
          ${transaction.json(result as never)}
        )
      `;
      return result;
    });
    return result as T;
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
