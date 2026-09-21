import { sanitizePgText } from "../../node/pg_text_sanitizer.js";
import type { SqlClient } from "../control_plane_types.js";
import type { SessionDeletionPort } from "../../session/session_deletion_service.js";
import {
  evaluateInitialSessionReview,
  readSessionReviewPolicy,
} from "../../system/session_review_policy.js";
import {
  idempotentSessionMutationRequestHash,
  runIdempotentSessionMutation,
} from "./idempotent_session_mutation.js";
import { lockWorktreeForSessionBinding } from "./worktree_repository.js";

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
  reasoningEffort?: string | null;
  notifyCompletion?: boolean | null;
  /**
   * Presence marks the central-review wire contract. Older workers omit this
   * field and keep their already-computed review values during rolling deploys.
   */
  callerInfo?: Record<string, unknown> | null;
  reviewRequired?: boolean;
  reviewState?: "not_required" | "needs_review" | "acknowledged";
};

export type RegisterSessionMutationResult = {
  ok: true;
  reviewRequired: boolean;
  reviewState: "not_required" | "needs_review" | "acknowledged";
  reviewDecision: "central_policy" | "legacy_worker";
  policyVersion: number | null;
};

export type RegisterSessionWithWorktreeMutation = RegisterSessionMutation & {
  worktreeId: string;
  worktreeActorSessionId: string;
  ownerTaskId: string | null;
};

type RegisterWireContract = "central_policy_v1" | "legacy_worker_v1";

type StoredRegisterSessionMutationResult = RegisterSessionMutationResult & {
  _registrationWireContract: RegisterWireContract;
  _registrationRequestHash: string;
};

type LegacyRegisterSessionMutationResult = { ok: true };

export class SessionMutationRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly sessionDeletion?: SessionDeletionPort,
  ) {}

  async registerSession(
    input: RegisterSessionMutation,
  ): Promise<RegisterSessionMutationResult> {
    const sanitizedInput = {
      ...input,
      prompt: sanitizePgText(input.prompt),
    };
    const hasCentralCallerInfo = Object.prototype.hasOwnProperty.call(
      sanitizedInput,
      "callerInfo",
    );
    const wireContract: RegisterWireContract = hasCentralCallerInfo
      ? "central_policy_v1"
      : "legacy_worker_v1";
    const exactRequestHash = idempotentSessionMutationRequestHash(sanitizedInput);
    const legacyHostRequestHash = idempotentSessionMutationRequestHash({
      ...sanitizedInput,
      ...(hasCentralCallerInfo
        ? { callerInfo: legacyPersistenceHostCamelCase(sanitizedInput.callerInfo) }
        : {}),
    });
    // callerInfo was added during a rolling wire upgrade. Keep the receipt key
    // compatible in both directions while storing an exact hash in result_json
    // so two requests from the same wire generation remain strict.
    const compatibilityInput: RegisterSessionMutation = { ...sanitizedInput };
    delete compatibilityInput.callerInfo;
    const stored = await this.idempotent<
      StoredRegisterSessionMutationResult | LegacyRegisterSessionMutationResult
    >("register_session", compatibilityInput, async (sql) => {
      // The idempotency receipt is checked before this callback. A retry therefore
      // returns the original decision even when an administrator changed policy.
      // FOR SHARE serializes this read with the admin CAS UPDATE, so the inserted
      // session and its policy version always belong to one ordering.
      const centralPolicy = hasCentralCallerInfo
        ? await readSessionReviewPolicy(sql, { lock: "share" })
        : undefined;
      const review = centralPolicy
        ? evaluateInitialSessionReview(sanitizedInput.callerInfo, centralPolicy)
        : {
            reviewRequired: sanitizedInput.reviewRequired ?? false,
            reviewState: sanitizedInput.reviewState ?? "not_required",
          };
      await sql`
        SELECT session_register_with_model_preset(
          ${sanitizedInput.sessionId}, ${sanitizedInput.nodeId},
          ${sanitizedInput.agentId}, ${sanitizedInput.claudeSessionId},
          ${sanitizedInput.sessionType}, ${sanitizedInput.prompt},
          ${sanitizedInput.clientId}, ${sanitizedInput.status},
          ${sanitizedInput.createdAt}, ${sanitizedInput.updatedAt},
          ${sanitizedInput.callerSessionId}, ${sanitizedInput.notifyCompletion ?? true},
          ${review.reviewRequired},
          ${review.reviewState},
          ${sanitizedInput.predecessorSessionId},
          ${sanitizedInput.modelPreset ?? null}, ${sanitizedInput.model ?? null},
          ${sanitizedInput.reasoningEffort ?? null}
        )
      `;
      return {
        ok: true,
        reviewRequired: review.reviewRequired,
        reviewState: review.reviewState,
        reviewDecision: centralPolicy ? "central_policy" : "legacy_worker",
        policyVersion: centralPolicy?.version ?? null,
        _registrationWireContract: wireContract,
        _registrationRequestHash: exactRequestHash,
      } as const;
    }, {
      // A new worker may have committed through the pre-policy host before the
      // host upgrade. That host hashed callerInfo and recursively camel-cased
      // its nested keys, so accept both representations for old {ok:true}
      // receipts while the generation marker below keeps new receipts strict.
      additionalAcceptedRequestHashes: [
        exactRequestHash,
        legacyHostRequestHash,
      ],
    });
    // Receipts created by the pre-policy orchestrator contain only {ok:true}.
    // The compatible hash proves the legacy review fields match, so reconstruct
    // the same decision for a new worker without rerunning registration.
    if (!isStoredRegisterSessionMutationResult(stored)) {
      return {
        ok: true,
        reviewRequired: sanitizedInput.reviewRequired ?? false,
        reviewState: sanitizedInput.reviewState ?? "not_required",
        reviewDecision: "legacy_worker",
        policyVersion: null,
      };
    }
    // A legacy worker ignores the response body and would continue from its
    // provisional review values. Never let it replay a registration that was
    // already committed from the central-policy wire contract: doing so could
    // later overwrite the stored decision through legacy lifecycle effects.
    if (
      stored._registrationWireContract === "central_policy_v1"
      && wireContract === "legacy_worker_v1"
    ) {
      throw hostError(
        409,
        `centrally reviewed registration cannot be replayed by a legacy worker: ${sanitizedInput.idempotencyKey}`,
      );
    }
    if (
      stored._registrationWireContract === wireContract
      && stored._registrationRequestHash !== exactRequestHash
    ) {
      throw hostError(409, `idempotency key conflict: ${sanitizedInput.idempotencyKey}`);
    }
    return {
      ok: true,
      reviewRequired: stored.reviewRequired,
      reviewState: stored.reviewState,
      reviewDecision: stored.reviewDecision,
      policyVersion: stored.policyVersion,
    };
  }

  /**
   * New, fail-closed wire operation. It is deliberately separate from
   * registerSession so an old orchestrator returns 404 instead of silently
   * running a worktree-bound session from the profile base directory.
   */
  async registerSessionWithWorktree(
    input: RegisterSessionWithWorktreeMutation,
  ): Promise<RegisterSessionMutationResult> {
    if (!input.worktreeId || !input.worktreeActorSessionId) {
      throw hostError(422, "worktreeId and worktreeActorSessionId are required");
    }
    const sanitizedInput = {
      ...input,
      prompt: sanitizePgText(input.prompt),
    };
    return await this.idempotent(
      "register_session_with_worktree",
      sanitizedInput,
      async (sql) => {
        await lockWorktreeForSessionBinding(sql, {
          worktreeId: sanitizedInput.worktreeId,
          nodeId: sanitizedInput.nodeId,
          actorSessionId: sanitizedInput.worktreeActorSessionId,
          ownerTaskId: sanitizedInput.ownerTaskId,
        });
        const centralPolicy = await readSessionReviewPolicy(sql, { lock: "share" });
        const review = evaluateInitialSessionReview(
          sanitizedInput.callerInfo ?? null,
          centralPolicy,
        );
        await sql`
          SELECT session_register_with_model_preset(
            ${sanitizedInput.sessionId}, ${sanitizedInput.nodeId},
            ${sanitizedInput.agentId}, ${sanitizedInput.claudeSessionId},
            ${sanitizedInput.sessionType}, ${sanitizedInput.prompt},
            ${sanitizedInput.clientId}, ${sanitizedInput.status},
            ${sanitizedInput.createdAt}, ${sanitizedInput.updatedAt},
            ${sanitizedInput.callerSessionId}, ${sanitizedInput.notifyCompletion ?? true},
            ${review.reviewRequired}, ${review.reviewState},
            ${sanitizedInput.predecessorSessionId},
            ${sanitizedInput.modelPreset ?? null}, ${sanitizedInput.model ?? null},
            ${sanitizedInput.reasoningEffort ?? null}
          )
        `;
        await sql`
          UPDATE sessions SET worktree_id = ${sanitizedInput.worktreeId}
          WHERE session_id = ${sanitizedInput.sessionId}
        `;
        return {
          ok: true,
          reviewRequired: review.reviewRequired,
          reviewState: review.reviewState,
          reviewDecision: "central_policy",
          policyVersion: centralPolicy.version,
        } as const;
      },
    );
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

  async reconcileNodeDisconnected(
    nodeId: string,
    updatedAt: Date,
    terminationDetail: "node_disconnect" | "node_disconnect_timeout",
  ): Promise<{
    interrupted: number;
    updates: Array<ReturnType<typeof mapReconciledSessionRow>>;
  }> {
    const rows = await this.sql<Array<ReconciledSessionRow>>`
      UPDATE sessions
      SET status = 'interrupted', was_running_at_shutdown = TRUE,
          termination_reason = 'killed', termination_detail = ${terminationDetail},
          review_state = CASE
            WHEN review_required THEN 'needs_review'
            ELSE 'acknowledged'
          END,
          updated_at = ${updatedAt}
        WHERE node_id = ${nodeId} AND status = 'running'
      RETURNING session_id, status, termination_reason, termination_detail,
                review_state, updated_at
    `;
    return {
      interrupted: rows.length,
      updates: rows.map(mapReconciledSessionRow),
    };
  }

  async listRunningNodeIds(): Promise<string[]> {
    const rows = await this.sql<Array<{ node_id: string }>>`
      SELECT DISTINCT node_id
      FROM sessions
      WHERE status = 'running' AND node_id IS NOT NULL
      ORDER BY node_id
    `;
    return rows
      .map((row) => row.node_id)
      .filter((nodeId) => typeof nodeId === "string" && nodeId.length > 0);
  }

  async reconcileNodeStartup(
    nodeId: string,
    runningSessionIds: string[],
    updatedAt: Date,
  ): Promise<{
    interrupted: number;
    restored: number;
    updates: Array<{
      sessionId: string;
      status: "interrupted" | "running";
      terminationReason: string | null;
      terminationDetail: string | null;
      reviewState: string;
      updatedAt: Date;
    }>;
  }> {
    return await this.sql.begin(async (sql) => {
      const interruptedRows = await sql<Array<ReconciledSessionRow>>`
        UPDATE sessions
        SET status = 'interrupted', was_running_at_shutdown = TRUE,
            termination_reason = 'killed', termination_detail = 'startup_reconciliation',
            review_state = CASE
              WHEN review_required THEN 'needs_review'
              ELSE 'acknowledged'
            END,
            updated_at = ${updatedAt}
      WHERE node_id = ${nodeId}
          AND updated_at <= ${updatedAt}
          AND NOT (session_id = ANY(${sql.array(runningSessionIds)}::text[]))
          AND (
            status = 'running'
            OR (
              status = 'initializing'
              AND execution_registration_id IS NULL
            )
          )
        RETURNING session_id, status, termination_reason, termination_detail,
                  review_state, updated_at
      `;
      await sql`
        SELECT id FROM worktrees
        WHERE id IN (
          SELECT worktree_id FROM sessions
          WHERE node_id = ${nodeId}
            AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
            AND worktree_id IS NOT NULL
        )
        FOR UPDATE
      `;
      const restoredRows = await sql<Array<ReconciledSessionRow>>`
        UPDATE sessions
        SET status = 'running', was_running_at_shutdown = FALSE,
            termination_reason = NULL, termination_detail = NULL,
            review_state = 'not_required',
            updated_at = ${updatedAt}
        WHERE node_id = ${nodeId}
          AND session_id = ANY(${sql.array(runningSessionIds)}::text[])
          AND status IN ('completed', 'error', 'interrupted')
          AND termination_event_id IS NULL
          AND updated_at <= ${updatedAt}
          AND (
            worktree_id IS NULL
            OR (
              EXISTS (
                SELECT 1 FROM worktrees
                WHERE worktrees.id = sessions.worktree_id
                  AND worktrees.state = 'ready'
                  AND (NOT worktrees.setup_required OR worktrees.setup_status = 'ready')
              )
              AND NOT EXISTS (
                SELECT 1 FROM sessions AS active
                WHERE active.worktree_id = sessions.worktree_id
                  AND active.session_id <> sessions.session_id
                  AND active.status IN ('initializing', 'running')
              )
            )
          )
        RETURNING session_id, status, termination_reason, termination_detail,
                  review_state, updated_at
      `;
      return {
        interrupted: interruptedRows.length,
        restored: restoredRows.length,
        updates: [...interruptedRows, ...restoredRows].map(mapReconciledSessionRow),
      };
    });
  }

  private async idempotent<T>(
    operation: string,
    input: { idempotencyKey: string; sessionId: string },
    mutate: (sql: SqlClient) => Promise<T>,
    options: { additionalAcceptedRequestHashes?: readonly string[] } = {},
  ): Promise<T> {
    return await runIdempotentSessionMutation(
      this.sql,
      operation,
      input,
      mutate,
      options,
    );
  }
}

type ReconciledSessionRow = {
  session_id: string;
  status: "interrupted" | "running";
  termination_reason: string | null;
  termination_detail: string | null;
  review_state: string;
  updated_at: Date | string;
};

function mapReconciledSessionRow(row: ReconciledSessionRow) {
  return {
    sessionId: row.session_id,
    status: row.status,
    terminationReason: row.termination_reason,
    terminationDetail: row.termination_detail,
    reviewState: row.review_state,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
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

function isStoredRegisterSessionMutationResult(
  value: StoredRegisterSessionMutationResult | LegacyRegisterSessionMutationResult,
): value is StoredRegisterSessionMutationResult {
  return "_registrationWireContract" in value
    && "_registrationRequestHash" in value;
}

function legacyPersistenceHostCamelCase(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => legacyPersistenceHostCamelCase(child));
  }
  if (typeof value === "string" && isLegacyHostDateValue(value, key)) {
    return new Date(value);
  }
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => {
      const camelKey = childKey.replace(
        /_([a-z])/g,
        (_match, letter: string) => letter.toUpperCase(),
      );
      return [camelKey, legacyPersistenceHostCamelCase(child, camelKey)];
    }),
  );
}

function isLegacyHostDateValue(value: string, key?: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  if (key === undefined) return true;
  return /(?:At|Before|Until|ExpiresAt)$/.test(key) && key !== "timestamp";
}
