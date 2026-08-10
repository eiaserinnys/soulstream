import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import {
  EVENT_OUTBOX_COMPACT_BYTES,
  EVENT_OUTBOX_COMPACT_ROWS,
  EVENT_OUTBOX_MAX_BATCH_BYTES,
  EVENT_OUTBOX_MAX_BATCH_EVENTS,
  EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES,
  computeEventOutboxPayloadHash,
  type EventOutboxAppendInput,
  type EventOutboxBatch,
  type EventOutboxRecord,
} from "../upstream/event_outbox.js";
import {
  RUNNER_BOOTSTRAP_EVENT_TYPE,
  RUNNER_EVENT_OUTBOX_DDL,
  RUNNER_EVENT_OUTBOX_SCHEMA_VERSION,
  type RunnerBootstrapInput,
  type RunnerBootstrapRecord,
  type RunnerEventOutboxRow,
} from "./sqlite_event_outbox_schema.js";
import {
  assertRunnerEventFits,
  buildRunnerEventBatch,
  runnerRowToBootstrap,
  runnerRowToRecord,
  sameRunnerBootstrapInput,
  stringifyRunnerJson,
  validateRunnerAppendInput,
  validateRunnerBootstrapInput,
} from "./sqlite_event_outbox_records.js";

export type {
  RunnerBootstrapInput,
  RunnerBootstrapRecord,
  RunnerResumeMaterial,
} from "./sqlite_event_outbox_schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type SqliteDatabase = InstanceType<typeof DatabaseSync>;

export class RunnerSqliteEventOutbox {
  private readonly appendListeners = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly database: SqliteDatabase,
    private bootstrap: RunnerBootstrapRecord | null,
    private acknowledgedThrough: number,
  ) {}

  static async open(databasePath: string): Promise<RunnerSqliteEventOutbox> {
    if (!databasePath || databasePath === ":memory:") {
      throw new Error("runner event outbox requires a file-backed SQLite path");
    }
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      await chmod(databasePath, 0o600);
      database.exec("PRAGMA busy_timeout = 5000");
      const journalMode = database.prepare("PRAGMA journal_mode = WAL").get() as {
        journal_mode: string;
      };
      if (journalMode.journal_mode.toLowerCase() !== "wal") {
        throw new Error("runner event outbox requires SQLite WAL journal mode");
      }
      database.exec("PRAGMA synchronous = FULL");
      database.exec(RUNNER_EVENT_OUTBOX_DDL);
      const version = readUserVersion(database);
      if (version > RUNNER_EVENT_OUTBOX_SCHEMA_VERSION) {
        throw new Error(`runner event outbox schema version ${version} is not supported`);
      }
      if (version === 0) {
        database.exec(`PRAGMA user_version = ${RUNNER_EVENT_OUTBOX_SCHEMA_VERSION}`);
      }
      const recovered = recover(database);
      return new RunnerSqliteEventOutbox(
        database,
        recovered.bootstrap,
        recovered.ackedThrough,
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  get streamId(): string {
    return this.requireBootstrap().stream_id;
  }

  get ackedSeq(): number {
    this.requireOpen();
    if (this.refreshBootstrap()) {
      this.acknowledgedThrough = readAcknowledgedThrough(this.database);
    }
    return this.acknowledgedThrough;
  }

  onAppend(listener: () => void): () => void {
    this.requireOpen();
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  async initializeBootstrap(input: RunnerBootstrapInput): Promise<RunnerBootstrapRecord> {
    this.requireOpen();
    validateRunnerBootstrapInput(input);
    if (this.bootstrap) {
      if (!sameRunnerBootstrapInput(this.bootstrap, input)) {
        throw new Error("runner bootstrap record conflicts with durable record");
      }
      return structuredClone(this.bootstrap);
    }

    const streamId = randomUUID();
    const unsigned = {
      stream_id: streamId,
      source_seq: 1 as const,
      session_id: input.session_id,
      event_type: RUNNER_BOOTSTRAP_EVENT_TYPE as typeof RUNNER_BOOTSTRAP_EVENT_TYPE,
      payload: structuredClone(input.resume),
      searchable_text: null,
      created_at: input.created_at,
      semantic_dedupe_key: null,
      session_effect: null,
    };
    const record: RunnerBootstrapRecord = {
      ...unsigned,
      payload_hash: computeEventOutboxPayloadHash(unsigned),
    };

    const durable = this.transaction(() => {
      const existingRow = this.database.prepare(`
        SELECT * FROM runner_event_outbox
        WHERE record_kind = 'bootstrap'
      `).get() as unknown as RunnerEventOutboxRow | undefined;
      if (existingRow) {
        const existing = runnerRowToBootstrap(existingRow);
        if (!sameRunnerBootstrapInput(existing, input)) {
          throw new Error("runner bootstrap record conflicts with durable record");
        }
        return existing;
      }
      if (rowCount(this.database) !== 0) {
        throw new Error("runner bootstrap record must be the first durable record");
      }
      insertRecord(this.database, "bootstrap", record, 1);
      return record;
    });
    this.bootstrap = durable;
    this.acknowledgedThrough = 1;
    return structuredClone(durable);
  }

  async readBootstrap(): Promise<RunnerBootstrapRecord | null> {
    this.requireOpen();
    const bootstrap = this.refreshBootstrap();
    return bootstrap === null ? null : structuredClone(bootstrap);
  }

  async append(input: EventOutboxAppendInput): Promise<EventOutboxRecord> {
    const bootstrap = this.requireBootstrap();
    validateRunnerAppendInput(input);
    if (input.session_id !== bootstrap.session_id) {
      throw new Error("runner event session_id differs from bootstrap record");
    }

    let record!: EventOutboxRecord;
    this.transaction(() => {
      const sourceSeq = latestSequence(this.database) + 1;
      const unsigned = {
        stream_id: bootstrap.stream_id,
        source_seq: sourceSeq,
        ...input,
      };
      record = {
        ...unsigned,
        payload_hash: computeEventOutboxPayloadHash(unsigned),
      };
      assertRunnerEventFits(record);
      insertRecord(this.database, "event", record, null);
    });
    for (const listener of this.appendListeners) listener();
    return record;
  }

  async readBatch(): Promise<EventOutboxBatch | null> {
    this.requireOpen();
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) return null;
    this.acknowledgedThrough = readAcknowledgedThrough(this.database);
    const rows = this.database.prepare(`
      SELECT * FROM runner_event_outbox
      WHERE record_kind = 'event' AND source_seq > ?
      ORDER BY source_seq
      LIMIT ?
    `).all(this.acknowledgedThrough, EVENT_OUTBOX_MAX_BATCH_EVENTS) as unknown as RunnerEventOutboxRow[];
    const pending = rows.map(runnerRowToRecord);
    if (pending.length === 0) return null;

    const selected: EventOutboxRecord[] = [];
    for (const record of pending) {
      const candidateArray = [...selected, record];
      const candidate: [EventOutboxRecord, ...EventOutboxRecord[]] = [
        candidateArray[0]!,
        ...candidateArray.slice(1),
      ];
      const frame = buildRunnerEventBatch(bootstrap.stream_id, candidate);
      const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
      if (frameBytes > EVENT_OUTBOX_MAX_BATCH_BYTES) {
        if (selected.length === 0 && frameBytes <= EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES) {
          selected.push(record);
        }
        break;
      }
      selected.push(record);
    }
    if (selected.length === 0) {
      throw new Error("event outbox record exceeds 2 MiB single-event contract");
    }
    return buildRunnerEventBatch(
      bootstrap.stream_id,
      selected as [EventOutboxRecord, ...EventOutboxRecord[]],
    );
  }

  async acknowledge(streamId: string, ackedThrough: number): Promise<void> {
    const bootstrap = this.requireBootstrap();
    if (streamId !== bootstrap.stream_id) {
      throw new Error("event outbox ACK stream_id mismatch");
    }
    if (!Number.isSafeInteger(ackedThrough) || ackedThrough <= 0) {
      throw new Error("event outbox ACK cursor must be a positive integer");
    }
    const previousCursor = this.acknowledgedThrough;
    const durableCursor = this.transaction(() => {
      const currentCursor = readAcknowledgedThrough(this.database);
      if (ackedThrough <= currentCursor) return currentCursor;
      if (ackedThrough > latestSequence(this.database)) {
        throw new Error("event outbox ACK exceeds durable append cursor");
      }
      this.database.prepare(`
        UPDATE runner_event_outbox
        SET acked_through = ?
        WHERE record_kind = 'bootstrap' AND acked_through < ?
      `).run(ackedThrough, ackedThrough);
      return ackedThrough;
    });
    this.acknowledgedThrough = Math.max(previousCursor, durableCursor);
    if (this.acknowledgedThrough > previousCursor) this.compactIfNeeded();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.appendListeners.clear();
    this.database.close();
  }

  private compactIfNeeded(): void {
    const rows = this.database.prepare(`
      SELECT * FROM runner_event_outbox
      WHERE record_kind = 'event' AND source_seq <= ?
      ORDER BY source_seq
    `).all(this.acknowledgedThrough) as unknown as RunnerEventOutboxRow[];
    const records = rows.map(runnerRowToRecord);
    const bytes = records.reduce(
      (total, record) => total + Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
      0,
    );
    if (records.length < EVENT_OUTBOX_COMPACT_ROWS && bytes < EVENT_OUTBOX_COMPACT_BYTES) {
      return;
    }
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM runner_event_outbox
        WHERE record_kind = 'event' AND source_seq <= ?
      `).run(this.acknowledgedThrough);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.requireOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireBootstrap(): RunnerBootstrapRecord {
    this.requireOpen();
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) {
      throw new Error("runner bootstrap record required before event append");
    }
    return bootstrap;
  }

  private refreshBootstrap(): RunnerBootstrapRecord | null {
    if (this.bootstrap) return this.bootstrap;
    const recovered = recover(this.database);
    this.bootstrap = recovered.bootstrap;
    this.acknowledgedThrough = recovered.ackedThrough;
    return this.bootstrap;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("runner event outbox is closed");
  }
}

function recover(database: SqliteDatabase): {
  bootstrap: RunnerBootstrapRecord | null;
  ackedThrough: number;
} {
  database.exec("BEGIN");
  try {
    const recovered = recoverSnapshot(database);
    database.exec("COMMIT");
    return recovered;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function recoverSnapshot(database: SqliteDatabase): {
  bootstrap: RunnerBootstrapRecord | null;
  ackedThrough: number;
} {
  const rows = database.prepare(
    "SELECT * FROM runner_event_outbox ORDER BY source_seq",
  ).all() as unknown as RunnerEventOutboxRow[];
  if (rows.length === 0) return { bootstrap: null, ackedThrough: 0 };

  const bootstrapRow = rows[0]!;
  if (bootstrapRow.record_kind !== "bootstrap" || bootstrapRow.source_seq !== 1) {
    throw new Error("runner bootstrap record must be source_seq 1");
  }
  const bootstrap = runnerRowToBootstrap(bootstrapRow);
  const ackedThrough = bootstrapRow.acked_through;
  if (ackedThrough === null || ackedThrough < 1) {
    throw new Error("runner event outbox ACK cursor is invalid");
  }

  const eventRows = rows.slice(1);
  let previous = eventRows[0]?.source_seq === 2 ? 1 : ackedThrough;
  for (const row of eventRows) {
    if (row.record_kind !== "event") throw new Error("runner event outbox record kind is invalid");
    if (row.stream_id !== bootstrap.stream_id) throw new Error("event outbox record stream mismatch");
    if (row.session_id !== bootstrap.session_id) throw new Error("event outbox record session mismatch");
    if (row.source_seq !== previous + 1) throw new Error("event outbox source_seq gap detected");
    runnerRowToRecord(row);
    previous = row.source_seq;
  }
  const latest = latestSequence(database);
  const lastDurable = eventRows.at(-1)?.source_seq ?? 1;
  if (latest > ackedThrough && lastDurable < latest) {
    throw new Error("event outbox durable unacknowledged prefix has a gap");
  }
  if (ackedThrough > latest) throw new Error("event outbox ACK exceeds durable append cursor");
  return { bootstrap, ackedThrough };
}

function insertRecord(
  database: SqliteDatabase,
  kind: "bootstrap" | "event",
  record: EventOutboxRecord,
  ackedThrough: number | null,
): void {
  database.prepare(`
    INSERT INTO runner_event_outbox (
      source_seq, record_kind, stream_id, session_id, event_type,
      payload_json, searchable_text, created_at, semantic_dedupe_key,
      session_effect_json, payload_hash, acked_through
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source_seq,
    kind,
    record.stream_id,
    record.session_id,
    record.event_type,
    stringifyRunnerJson(record.payload, "payload"),
    record.searchable_text,
    record.created_at,
    record.semantic_dedupe_key,
    record.session_effect === null
      ? null
      : stringifyRunnerJson(record.session_effect, "session_effect"),
    record.payload_hash,
    ackedThrough,
  );
}

function latestSequence(database: SqliteDatabase): number {
  const row = database.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name = 'runner_event_outbox'",
  ).get() as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function rowCount(database: SqliteDatabase): number {
  const row = database.prepare(
    "SELECT COUNT(*) AS count FROM runner_event_outbox",
  ).get() as { count: number };
  return row.count;
}

function readUserVersion(database: SqliteDatabase): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function readAcknowledgedThrough(database: SqliteDatabase): number {
  const row = database.prepare(`
    SELECT acked_through FROM runner_event_outbox
    WHERE record_kind = 'bootstrap'
  `).get() as { acked_through: number } | undefined;
  if (!row || !Number.isSafeInteger(row.acked_through) || row.acked_through < 1) {
    throw new Error("runner event outbox ACK cursor is invalid");
  }
  return row.acked_through;
}
