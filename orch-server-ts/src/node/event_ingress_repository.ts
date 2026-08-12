import type { LiveDbSqlResolver, LivePostgresSql } from "../runtime/live_db_sql.js";
import type {
  CommittedIngressEvent,
  EventAppendBatch,
  EventIngressEnvelope,
  EventSessionEffectApplication,
  EventSessionEffectApplicationWire,
  EventSessionEffect,
} from "./event_ingress_types.js";

type QueryRows = readonly Record<string, unknown>[];

export type EventIngressQuerySql = {
  <T extends QueryRows = QueryRows>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
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

export class EventIngressProtocolConflict extends Error {
  readonly statusCode = 409;
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
  constructor(
    private readonly sqlProvider: EventIngressSqlProvider,
    private readonly applySessionEffect?: EventSessionEffectApplier,
  ) {}

  async commitBatch(
    nodeId: string,
    batch: EventAppendBatch,
  ): Promise<CommittedIngressEvent[]> {
    const sql = await this.sqlProvider.resolveSql();
    return await sql.begin(async (transaction) => {
      const committed: CommittedIngressEvent[] = [];
      for (const envelope of batch.events) {
        const receipt = await findReceipt(transaction, nodeId, batch.stream_id, envelope.source_seq);
        if (receipt) {
          assertReceiptMatches(receipt, envelope);
          const sessionEffectApplication = parseEffectApplication(
            receipt.effect_application,
          );
          committed.push({
            envelope,
            eventId: receipt.event_id,
            duplicateReceipt: true,
            ...(sessionEffectApplication ? { sessionEffectApplication } : {}),
          });
          continue;
        }

        const semanticReceipt = envelope.semantic_dedupe_key
          ? await findSemanticEvent(
              transaction,
              envelope.session_id,
              envelope.semantic_dedupe_key,
            )
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
        } else if (
          semanticReceipt
          && isCanonicalTransitionEffect(envelope.session_effect)
        ) {
          sessionEffectApplication = await findCanonicalEffectApplication(
            transaction,
            envelope.session_id,
            eventId,
          );
        }

        const receiptApplication = toReceiptEffectApplication(
          sessionEffectApplication,
        );

        await transaction`
          INSERT INTO event_ingress_receipts (
            node_id, stream_id, source_seq, session_id, payload_hash, event_id,
            effect_application
          ) VALUES (
            ${nodeId}, ${batch.stream_id}, ${envelope.source_seq},
            ${envelope.session_id}, ${envelope.payload_hash}, ${eventId},
            CAST(${receiptApplication === null
              ? null
              : JSON.stringify(receiptApplication)} AS JSONB)
          )
        `;
        // A semantic receipt means the durable event/effect was already
        // committed under a prior transport coordinate. Preserve the stable
        // event identity and suppress a second projection-side effect.
        committed.push({
          envelope,
          eventId,
          duplicateReceipt: semanticReceipt !== undefined,
          ...(sessionEffectApplication ? { sessionEffectApplication } : {}),
        });
      }
      return committed;
    });
  }
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
  const application = parseEffectApplication(rows[0]?.effect_application);
  if (!application?.canonicalSession) {
    throw new Error(
      "semantic transition receipt is missing its canonical effect application",
    );
  }
  return application;
}

function isCanonicalTransitionEffect(
  effect: EventSessionEffect | null,
): effect is Extract<
  EventSessionEffect,
  { kind: "running_transition" | "terminal_transition" }
> {
  return effect?.kind === "running_transition" || effect?.kind === "terminal_transition";
}

function toReceiptEffectApplication(
  application: EventSessionEffectApplication | undefined,
): EventSessionEffectApplicationWire | null {
  return application?.canonicalSession
    ? {
        applied: application.applied,
        canonical_session: application.canonicalSession,
      }
    : null;
}

function parseEffectApplication(
  value: unknown,
): EventSessionEffectApplication | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.applied !== "boolean" || !isCanonicalSession(value.canonical_session)) {
    throw new Error("event ingress receipt has invalid effect_application");
  }
  return {
    applied: value.applied,
    canonicalSession: value.canonical_session,
  };
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
  return (async <T extends QueryRows>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => await sql(strings, ...values) as T) as EventIngressQuerySql;
}
