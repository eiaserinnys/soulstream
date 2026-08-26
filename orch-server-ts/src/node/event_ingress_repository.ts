import type { LiveDbSqlResolver, LivePostgresSql } from "../runtime/live_db_sql.js";
import type {
  EventAppendBatch,
  EventIngressEnvelope,
  EventIngressResult,
  EventSessionEffectApplication,
  EventSessionEffectApplicationWire,
  EventSessionEffect,
} from "./event_ingress_types.js";
import {
  type EventIngressDeadLetterStore,
  type PersistedEventIngressDeadLetter,
} from "./event_ingress_dead_letter_store.js";
import {
  completedIngressResults,
  EventIngressRetryPolicy,
  type EventIngressRetryPolicyOptions,
} from "./event_ingress_retry_policy.js";

type QueryRows = readonly Record<string, unknown>[];

export type EventIngressQuerySql = {
  <T extends QueryRows = QueryRows>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  // postgres.js serialises a plain JS string bound to a JSONB parameter as a
  // JSON *string*, so JSON.stringify() before the bind double-encodes the value.
  // Callers writing JSONB must route the object through json().
  readonly json: (value: unknown) => unknown;
};

export type EventIngressSql = EventIngressQuerySql & {
  begin<T>(callback: (sql: EventIngressQuerySql) => Promise<T>): Promise<T>;
};

export type EventIngressSqlProvider = {
  resolveSql(): Promise<EventIngressSql>;
};

export type EventSessionEffectApplier = (
  sql: EventIngressQuerySql,
  input: {
    nodeId: string;
    eventId: number;
    envelope: EventIngressEnvelope;
    effect: EventSessionEffect;
  },
) => Promise<EventSessionEffectApplication>;

export type EventIngressRepositoryOptions = EventIngressRetryPolicyOptions;

export class EventIngressProtocolConflict extends Error {
  readonly statusCode = 409;

  constructor(message: string, readonly sourceSeq?: number) {
    super(message);
  }
}

export class LiveEventIngressSqlProvider implements EventIngressSqlProvider {
  private resolved?: Promise<EventIngressSql>;

  constructor(private readonly resolver: LiveDbSqlResolver) {}

  resolveSql(): Promise<EventIngressSql> {
    this.resolved ??= this.resolver.resolveSql().then(createEventIngressSqlAdapter);
    return this.resolved;
  }
}

export class EventIngressRepository {
  private readonly retryPolicy: EventIngressRetryPolicy;

  constructor(
    private readonly sqlProvider: EventIngressSqlProvider,
    private readonly applySessionEffect?: EventSessionEffectApplier,
    private readonly deadLetterStore?: EventIngressDeadLetterStore,
    options: EventIngressRepositoryOptions = {},
  ) {
    this.retryPolicy = new EventIngressRetryPolicy(options);
  }

  async commitBatch(
    nodeId: string,
    batch: EventAppendBatch,
  ): Promise<EventIngressResult[]> {
    const results = new Array<EventIngressResult | undefined>(batch.events.length);
    let pending: Array<{ index: number; envelope: EventIngressEnvelope }> = [];
    for (let index = 0; index < batch.events.length; index += 1) {
      const envelope = batch.events[index]!;
      const existing = await this.deadLetterStore?.find({ nodeId, envelope }) ?? null;
      if (existing) results[index] = deadLetterResult(envelope, existing);
      else pending.push({ index, envelope });
    }
    if (pending.length === 0) return completedIngressResults(results);

    const sql = await this.sqlProvider.resolveSql();
    while (pending.length > 0) {
      const retry: Array<{
        index: number;
        envelope: EventIngressEnvelope;
        failureCount: number;
      }> = [];
      for (const item of pending) {
        try {
          results[item.index] = await sql.begin(async (transaction) =>
            await this.commitEnvelope(transaction, nodeId, batch.stream_id, item.envelope));
        } catch (error) {
          if (!this.deadLetterStore) throw error;
          await this.retryPolicy.assertDatabaseReachable(sql, error);
          const decision = await this.deadLetterStore.recordFailure({
            nodeId,
            envelope: item.envelope,
            failure: this.retryPolicy.failureDetail(error),
            threshold: this.retryPolicy.failureThreshold,
          });
          if (decision.deadLetter) {
            results[item.index] = deadLetterResult(item.envelope, decision.deadLetter);
          } else {
            retry.push({ ...item, failureCount: decision.failureCount });
          }
        }
      }
      if (retry.length === 0) break;
      await this.retryPolicy.waitForRetry(retry.map((item) => item.failureCount));
      pending = retry;
    }
    return completedIngressResults(results);
  }

  private async commitEnvelope(
    transaction: EventIngressQuerySql,
    nodeId: string,
    streamId: string,
    envelope: EventIngressEnvelope,
  ): Promise<EventIngressResult> {
    const receipt = await findReceipt(transaction, nodeId, streamId, envelope.source_seq);
    if (receipt) {
      assertReceiptMatches(receipt, envelope);
      const sessionEffectApplication = parseEffectApplication(
        receipt.effect_application,
        envelope.source_seq,
      );
      return {
        outcome: "committed",
        envelope,
        eventId: receipt.event_id,
        duplicateReceipt: true,
        ...(sessionEffectApplication ? { sessionEffectApplication } : {}),
      };
    }
    const sessionGeneration = await lockSession(transaction, envelope.session_id);
    if (sessionGeneration === null) {
      throw new Error(`session ${envelope.session_id} does not exist`);
    }
    if (envelope.execution_generation !== undefined
      && envelope.execution_generation !== null
      && envelope.execution_generation !== sessionGeneration) {
      return {
        outcome: "dead_lettered",
        envelope,
        deadLetter: {
          code: "STALE_EXECUTION_GENERATION",
          reason: `execution generation ${envelope.execution_generation} is not current`,
          rejectedAt: new Date().toISOString(),
          path: "execution_generation",
        },
      };
    }

    const semanticReceipt = envelope.semantic_dedupe_key
      ? await findSemanticEvent(transaction, envelope.session_id, envelope.semantic_dedupe_key)
      : undefined;
    const eventId = semanticReceipt?.event_id ?? await appendEvent(transaction, envelope);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      throw new Error("event_append did not return a positive event id");
    }

    let sessionEffectApplication: EventSessionEffectApplication | undefined;
    if (!semanticReceipt && envelope.session_effect !== null) {
      if (!this.applySessionEffect) {
        throw new Error("typed session effects are not enabled in this release");
      }
      sessionEffectApplication = await this.applySessionEffect(transaction, {
        nodeId,
        eventId,
        envelope,
        effect: envelope.session_effect,
      });
    } else if (semanticReceipt && isCanonicalTransitionEffect(envelope.session_effect)) {
      sessionEffectApplication = await findCanonicalEffectApplication(
        transaction,
        envelope.session_id,
        eventId,
        envelope.source_seq,
      );
    }

    const receiptApplication = toReceiptEffectApplication(sessionEffectApplication);
    await transaction`
      INSERT INTO event_ingress_receipts (
        node_id, stream_id, source_seq, session_id, payload_hash, event_id,
        effect_application
      ) VALUES (
        ${nodeId}, ${streamId}, ${envelope.source_seq},
        ${envelope.session_id}, ${envelope.payload_hash}, ${eventId},
        ${receiptApplication === null
          ? null
          : transaction.json(receiptApplication)}::jsonb
      )
    `;
    return {
      outcome: "committed",
      envelope,
      eventId,
      duplicateReceipt: semanticReceipt !== undefined,
      ...(sessionEffectApplication ? { sessionEffectApplication } : {}),
    };
  }
}

async function lockSession(
  sql: EventIngressQuerySql,
  sessionId: string,
): Promise<number | null> {
  const rows = await sql<Array<{ execution_generation: string | number }>>`
    SELECT execution_generation
    FROM sessions
    WHERE session_id = ${sessionId}
    FOR UPDATE
  `;
  if (!rows[0]) return null;
  const generation = Number(rows[0].execution_generation);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`session ${sessionId} has an invalid execution generation`);
  }
  return generation;
}

function deadLetterResult(
  envelope: EventIngressEnvelope,
  deadLetter: PersistedEventIngressDeadLetter,
): EventIngressResult {
  return {
    outcome: "dead_lettered",
    envelope,
    deadLetter,
  };
}

async function appendEvent(
  sql: EventIngressQuerySql,
  envelope: EventIngressEnvelope,
): Promise<number> {
  const rows = await sql<Array<{ event_id: number }>>`
    SELECT event_append(
      ${envelope.session_id},
      ${envelope.event_type},
      ${JSON.stringify(envelope.payload)},
      ${envelope.searchable_text},
      ${new Date(envelope.created_at)},
      ${envelope.semantic_dedupe_key}
    ) AS event_id
  `;
  return Number(rows[0]?.event_id);
}

async function findSemanticEvent(
  sql: EventIngressQuerySql,
  sessionId: string,
  dedupeKey: string,
): Promise<{ event_id: number } | undefined> {
  // This lock extends event_append's semantic uniqueness to its paired session
  // effect. A retried event may receive a new transport source_seq, but it must
  // never apply the domain mutation twice.
  const lockKey = JSON.stringify([sessionId, dedupeKey]);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const rows = await sql<Array<{ event_id: number }>>`
    SELECT id AS event_id
    FROM events
    WHERE session_id = ${sessionId} AND dedupe_key = ${dedupeKey}
    LIMIT 1
  `;
  return rows[0];
}

type ReceiptRow = {
  session_id: string;
  payload_hash: string;
  event_id: number;
  effect_application?: unknown;
};

async function findReceipt(
  sql: EventIngressQuerySql,
  nodeId: string,
  streamId: string,
  sourceSeq: number,
): Promise<ReceiptRow | undefined> {
  const rows = await sql<ReceiptRow[]>`
    SELECT session_id, payload_hash, event_id, effect_application
    FROM event_ingress_receipts
    WHERE node_id = ${nodeId}
      AND stream_id = ${streamId}
      AND source_seq = ${sourceSeq}
    FOR UPDATE
  `;
  return rows[0];
}

async function findCanonicalEffectApplication(
  sql: EventIngressQuerySql,
  sessionId: string,
  eventId: number,
  sourceSeq: number,
): Promise<EventSessionEffectApplication> {
  const rows = await sql<Array<{ effect_application: unknown }>>`
    SELECT effect_application
    FROM event_ingress_receipts
    WHERE session_id = ${sessionId}
      AND event_id = ${eventId}
      AND effect_application IS NOT NULL
    ORDER BY created_at
    LIMIT 1
  `;
  const application = parseEffectApplication(rows[0]?.effect_application, sourceSeq);
  if (!application?.canonicalSession) {
    // Permanent for this envelope: the durable receipt it replays cannot supply a
    // canonical projection, and no amount of retrying will make one appear. The
    // repository's error-agnostic retry policy eventually dead-letters this envelope.
    throw new EventIngressProtocolConflict(
      `semantic transition receipt is missing its canonical effect application at source_seq ${sourceSeq}`,
      sourceSeq,
    );
  }
  return application;
}

function isCanonicalTransitionEffect(
  effect: EventSessionEffect | null,
): effect is Extract<
  EventSessionEffect,
  {
    kind:
      | "running_transition"
      | "terminal_transition"
      | "execution_acquire"
      | "execution_reserve"
      | "execution_prove"
      | "execution_adopt_reserve"
      | "execution_activate"
      | "execution_fail"
      | "execution_expire_dead_owner"
      | "execution_orphaned_spawn"
      | "runner_terminal_fact"
      | "recovered_runner_terminal_fact";
  }
> {
  return effect?.kind === "running_transition"
    || effect?.kind === "terminal_transition"
    || effect?.kind === "execution_acquire"
    || effect?.kind === "execution_reserve"
    || effect?.kind === "execution_prove"
    || effect?.kind === "execution_adopt_reserve"
    || effect?.kind === "execution_activate"
    || effect?.kind === "execution_fail"
    || effect?.kind === "execution_expire_dead_owner"
    || effect?.kind === "execution_orphaned_spawn"
    || effect?.kind === "runner_terminal_fact"
    || effect?.kind === "recovered_runner_terminal_fact";
}

function toReceiptEffectApplication(
  application: EventSessionEffectApplication | undefined,
): EventSessionEffectApplicationWire | null {
  return application?.canonicalSession
    ? {
        applied: application.applied,
        canonical_session: application.canonicalSession,
        ...(application.canonicalExecutionOwnership === undefined
          ? {}
          : {
              canonical_execution_ownership:
                application.canonicalExecutionOwnership,
            }),
      }
    : null;
}

function parseEffectApplication(
  value: unknown,
  sourceSeq: number,
): EventSessionEffectApplication | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.applied !== "boolean" || !isCanonicalSession(value.canonical_session)) {
    // Stored shape, not transport state: retrying re-reads the same bad row.
    throw new EventIngressProtocolConflict(
      `event ingress receipt has invalid effect_application at source_seq ${sourceSeq}`,
      sourceSeq,
    );
  }
  return {
    applied: value.applied,
    canonicalSession: value.canonical_session,
    ...(value.canonical_execution_ownership === undefined
      ? {}
      : {
          canonicalExecutionOwnership:
            parseCanonicalExecutionOwnership(value.canonical_execution_ownership, sourceSeq),
        }),
  };
}

function parseCanonicalExecutionOwnership(
  value: unknown,
  sourceSeq: number,
): EventSessionEffectApplicationWire["canonical_execution_ownership"] {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.ownership_generation)
    || Number(value.ownership_generation) <= 0
    || !["runner_process", "adopted_runner", "in_process"].includes(String(value.owner_kind))
    || typeof value.manifest_id !== "string"
    || (value.registration_id !== null && typeof value.registration_id !== "string")
    || (value.pid !== null && (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0))
    || (value.start_identity !== null && typeof value.start_identity !== "string")
    || (value.execution_command_id !== null && typeof value.execution_command_id !== "string")
    || !["reserved", "identity_proven", "active", "terminal", "failed"]
      .includes(String(value.phase))
    || (value.failure_reason !== null && typeof value.failure_reason !== "string")
  ) {
    throw new EventIngressProtocolConflict(
      `event ingress receipt has invalid canonical ownership at source_seq ${sourceSeq}`,
      sourceSeq,
    );
  }
  return value as EventSessionEffectApplicationWire["canonical_execution_ownership"];
}

function isCanonicalSession(
  value: unknown,
): value is EventSessionEffectApplicationWire["canonical_session"] {
  if (!isRecord(value)) return false;
  return typeof value.status === "string"
    && (value.termination_reason === null || typeof value.termination_reason === "string")
    && (value.termination_detail === null || typeof value.termination_detail === "string")
    && typeof value.review_state === "string"
    && (value.last_assistant_text === null || typeof value.last_assistant_text === "string")
    && (value.termination_event_id === null
      || Number.isSafeInteger(value.termination_event_id))
    && typeof value.updated_at === "string"
    && (value.last_event_id === null || Number.isSafeInteger(value.last_event_id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertReceiptMatches(receipt: ReceiptRow, envelope: EventIngressEnvelope): void {
  if (
    receipt.session_id !== envelope.session_id
    || receipt.payload_hash !== envelope.payload_hash
  ) {
    throw new EventIngressProtocolConflict(
      `ingress receipt conflict at source_seq ${envelope.source_seq}`,
      envelope.source_seq,
    );
  }
}

function createEventIngressSqlAdapter(sql: LivePostgresSql): EventIngressSql {
  const candidate = sql as LivePostgresSql & {
    begin?: <T>(callback: (sql: LivePostgresSql) => Promise<T>) => Promise<T>;
  };
  if (typeof candidate.begin !== "function") {
    throw new Error("event ingress SQL requires postgres.js begin()");
  }
  const query = createQueryAdapter(sql);
  return Object.assign(query, {
    begin: <T>(callback: (transaction: EventIngressQuerySql) => Promise<T>) =>
      candidate.begin!((transaction) => callback(createQueryAdapter(transaction))),
  }) as EventIngressSql;
}

function createQueryAdapter(sql: LivePostgresSql): EventIngressQuerySql {
  const query = (async <T extends QueryRows>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => await sql(strings, ...values) as T);
  return Object.assign(query, {
    json: (value: unknown) => sql.json(value),
  }) as EventIngressQuerySql;
}
