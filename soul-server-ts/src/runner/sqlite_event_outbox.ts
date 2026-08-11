import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
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
  type RunnerIpcJournalRow,
} from "./sqlite_event_outbox_schema.js";
import { engineEventFrame, type RunnerEventFrame } from "./frame_protocol.js";
import {
  assertRunnerEventFits,
  buildRunnerEventBatch,
  runnerRowToBootstrap,
  runnerRowToRecord,
  sameRunnerBootstrapInput,
  validateRunnerAppendInput,
  validateRunnerBootstrapInput,
} from "./sqlite_event_outbox_records.js";
import {
  assertRunnerAckCheckpoint,
  computeRunnerAckCheckpointHash,
  insertRunnerRecord as insertRecord,
  latestRunnerSequence as latestSequence,
  readRunnerAcknowledgedThrough as readAcknowledgedThrough,
  readRunnerSchemaVersion as readUserVersion,
  recoverRunnerOutbox as recover,
  runnerRowCount as rowCount,
  runnerTableHasColumn as hasColumn,
} from "./sqlite_event_outbox_database.js";
import { ensureRunnerLifecycleColumns } from "./sqlite_runner_lifecycle.js";
import {
  acknowledgeRunnerHostCall,
  ensureRunnerIpcJournalV4,
  readRunnerHostCallApplied,
  recordRunnerHostCallApplied,
} from "./sqlite_ipc_journal.js";
import { loadNodeSqlite } from "./node_sqlite.js";

export type { RunnerBootstrapInput, RunnerBootstrapRecord, RunnerResumeMaterial }
  from "./sqlite_event_outbox_schema.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;

export class RunnerSqliteEventOutbox {
  private readonly appendListeners = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly database: SqliteDatabase,
    readonly databasePath: string,
    private bootstrap: RunnerBootstrapRecord | null,
    private acknowledgedThrough: number,
  ) {}

  static async open(databasePath: string): Promise<RunnerSqliteEventOutbox> {
    await assertExistingRunnerDatabase(databasePath);
    return await RunnerSqliteEventOutbox.openDatabase(databasePath);
  }

  static async create(databasePath: string): Promise<RunnerSqliteEventOutbox> {
    if (!databasePath || databasePath === ":memory:") {
      throw new Error("runner event outbox requires a file-backed SQLite path");
    }
    await mkdir(dirname(databasePath), { recursive: true });
    try {
      const existing = await stat(databasePath);
      if (existing.size === 0) {
        throw new Error(`runner event outbox is an empty SQLite file: ${databasePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return await RunnerSqliteEventOutbox.openDatabase(databasePath);
  }

  private static async openDatabase(databasePath: string): Promise<RunnerSqliteEventOutbox> {
    const { DatabaseSync } = loadNodeSqlite();
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
      database.exec("PRAGMA foreign_keys = ON");
      const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      };
      if (foreignKeys.foreign_keys !== 1) {
        throw new Error("runner event outbox requires SQLite foreign key enforcement");
      }
      database.exec(RUNNER_EVENT_OUTBOX_DDL);
      const version = readUserVersion(database);
      if (version > RUNNER_EVENT_OUTBOX_SCHEMA_VERSION) {
        throw new Error(`runner event outbox schema version ${version} is not supported`);
      }
      if (!hasColumn(database, "runner_event_outbox", "runner_metadata_json")) {
        database.exec(`
          ALTER TABLE runner_event_outbox
          ADD COLUMN runner_metadata_json TEXT CHECK (
            runner_metadata_json IS NULL OR json_valid(runner_metadata_json)
          )
        `);
      }
      ensureRunnerLifecycleColumns(database);
      ensureRunnerIpcJournalV4(database);
      const recovered = recover(database, {
        migrateLegacyAckCheckpoint: version < RUNNER_EVENT_OUTBOX_SCHEMA_VERSION,
      });
      if (version < RUNNER_EVENT_OUTBOX_SCHEMA_VERSION) {
        database.exec(`PRAGMA user_version = ${RUNNER_EVENT_OUTBOX_SCHEMA_VERSION}`);
      }
      return new RunnerSqliteEventOutbox(
        database,
        databasePath,
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
        assertRunnerAckCheckpoint(existingRow);
        const existing = runnerRowToBootstrap(existingRow);
        if (!sameRunnerBootstrapInput(existing, input)) {
          throw new Error("runner bootstrap record conflicts with durable record");
        }
        return existing;
      }
      if (rowCount(this.database) !== 0) {
        throw new Error("runner bootstrap record must be the first durable record");
      }
      insertRecord(
        this.database,
        "bootstrap",
        record,
        1,
        null,
        computeRunnerAckCheckpointHash(record.stream_id, record.session_id, 1),
      );
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

  /**
   * Atomically appends one orch-bound event and a payload-free IPC ordering
   * reference. The journal never stores domain payload or metadata; replay
   * reconstructs the frame from runner_event_outbox.
   */
  async appendEngineFrame(
    input: EventOutboxAppendInput,
    frame: Extract<RunnerEventFrame, { kind: "engine_event" }>,
  ): Promise<EventOutboxRecord & { ipc_frame_seq: number }> {
    const bootstrap = this.requireBootstrap();
    validateRunnerAppendInput(input);
    if (input.session_id !== bootstrap.session_id) {
      throw new Error("runner event session_id differs from bootstrap record");
    }
    const parsedFrame = engineEventFrame(frame.payload, frame.metadata);
    if (JSON.stringify(parsedFrame.payload) !== JSON.stringify(input.payload)) {
      throw new Error("runner frame payload differs from durable event payload");
    }

    let record!: EventOutboxRecord;
    let frameSeq!: number;
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
      insertRecord(
        this.database,
        "event",
        record,
        null,
        parsedFrame.metadata ?? null,
      );
      const result = this.database.prepare(`
        INSERT INTO runner_ipc_journal (
          outbox_source_seq, frame_kind, host_acked, created_at
        ) VALUES (?, 'engine_event', 0, ?)
      `).run(record.source_seq, record.created_at);
      frameSeq = Number(result.lastInsertRowid);
    });
    for (const listener of this.appendListeners) listener();
    return { ...record, ipc_frame_seq: frameSeq };
  }

  async readPendingIpcFrames(): Promise<Array<{
    frame_seq: number;
    outbox_source_seq: number;
    frame: Extract<RunnerEventFrame, { kind: "engine_event" }>;
  }>> {
    this.requireOpen();
    const rows = this.database.prepare(`
      SELECT
        journal.frame_seq,
        journal.outbox_source_seq,
        journal.frame_kind,
        journal.host_acked,
        journal.created_at,
        outbox.*
      FROM runner_ipc_journal AS journal
      JOIN runner_event_outbox AS outbox
        ON outbox.source_seq = journal.outbox_source_seq
      WHERE journal.host_acked = 0
      ORDER BY journal.frame_seq
    `).all() as unknown as Array<RunnerIpcJournalRow & RunnerEventOutboxRow>;
    return rows.map((row) => {
      if (row.outbox_source_seq === null || row.frame_kind !== "engine_event") {
        throw new Error("runner IPC event journal row is invalid");
      }
      const record = runnerRowToRecord(row);
      const metadata = row.runner_metadata_json === null
        ? undefined
        : JSON.parse(row.runner_metadata_json) as unknown;
      return {
        frame_seq: row.frame_seq,
        outbox_source_seq: row.outbox_source_seq,
        frame: engineEventFrame(record.payload, metadata) as Extract<
          RunnerEventFrame,
          { kind: "engine_event" }
        >,
      };
    });
  }

  async acknowledgeHostFrame(frameSeq: number): Promise<void> {
    this.requireOpen();
    if (!Number.isSafeInteger(frameSeq) || frameSeq <= 0) {
      throw new Error("runner IPC host ACK cursor must be a positive integer");
    }
    this.transaction(() => {
      this.database.prepare(`
        UPDATE runner_ipc_journal SET host_acked = 1
        WHERE frame_seq = ?
      `).run(frameSeq);
    });
    this.compactJournal();
    this.compactIfNeeded();
  }

  async recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): Promise<void> {
    this.requireOpen();
    recordRunnerHostCallApplied(this.database, input);
  }

  async readHostCallApplied(correlationId: string): Promise<{
    correlationId: string;
    service: string;
    operation: string;
  } | null> {
    this.requireOpen();
    return readRunnerHostCallApplied(this.database, correlationId);
  }

  async acknowledgeHostCall(correlationId: string): Promise<void> {
    this.requireOpen();
    acknowledgeRunnerHostCall(this.database, correlationId);
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

  async readRecord(sourceSeq: number): Promise<EventOutboxRecord | null> {
    this.requireOpen();
    const row = this.database.prepare(`
      SELECT * FROM runner_event_outbox WHERE source_seq = ?
    `).get(sourceSeq) as unknown as RunnerEventOutboxRow | undefined;
    if (!row || row.record_kind !== "event") return null;
    return runnerRowToRecord(row);
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
      const checkpoint = this.database.prepare(`
        SELECT stream_id, session_id, acked_through, ack_checkpoint_hash
        FROM runner_event_outbox WHERE record_kind = 'bootstrap'
      `).get() as Pick<
        RunnerEventOutboxRow,
        "stream_id" | "session_id" | "acked_through" | "ack_checkpoint_hash"
      > | undefined;
      if (!checkpoint) throw new Error("runner bootstrap record is missing");
      assertRunnerAckCheckpoint(checkpoint);
      const currentCursor = checkpoint.acked_through!;
      if (ackedThrough <= currentCursor) return currentCursor;
      if (ackedThrough > latestSequence(this.database)) {
        throw new Error("event outbox ACK exceeds durable append cursor");
      }
      const nextHash = computeRunnerAckCheckpointHash(
        checkpoint.stream_id,
        checkpoint.session_id,
        ackedThrough,
      );
      const result = this.database.prepare(`
        UPDATE runner_event_outbox
        SET acked_through = ?, ack_checkpoint_hash = ?
        WHERE record_kind = 'bootstrap'
          AND acked_through = ? AND ack_checkpoint_hash = ?
      `).run(
        ackedThrough,
        nextHash,
        currentCursor,
        checkpoint.ack_checkpoint_hash,
      );
      if (Number(result.changes) !== 1) {
        throw new Error("runner event outbox ACK checkpoint changed concurrently");
      }
      const verifiedCursor = readAcknowledgedThrough(this.database);
      if (verifiedCursor !== ackedThrough) {
        throw new Error("runner event outbox ACK checkpoint update was not durable");
      }
      return verifiedCursor;
    });
    this.acknowledgedThrough = Math.max(previousCursor, durableCursor);
    if (this.acknowledgedThrough > previousCursor) {
      this.compactJournal();
      this.compactIfNeeded();
    }
  }

  /** Final-ACK evidence used by release GC; true is fail-safe retention. */
  async hasPendingDurableWork(): Promise<boolean> {
    this.requireOpen();
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) return true;
    const acknowledgedThrough = readAcknowledgedThrough(this.database);
    const pendingEvent = this.database.prepare(`
      SELECT 1 FROM runner_event_outbox
      WHERE record_kind = 'event' AND source_seq > ?
      LIMIT 1
    `).get(acknowledgedThrough);
    if (pendingEvent) return true;
    const pendingIpc = this.database.prepare(`
      SELECT 1 FROM runner_ipc_journal LIMIT 1
    `).get();
    return pendingIpc !== undefined;
  }

  async compactAppliedHostCallsForTerminalRecovery(): Promise<void> {
    this.requireOpen();
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM runner_ipc_journal
        WHERE frame_kind = 'host_call'
          AND host_acked = 1
          AND outbox_source_seq IS NULL
      `).run();
    });
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
          AND NOT EXISTS (
            SELECT 1 FROM runner_ipc_journal
            WHERE outbox_source_seq = runner_event_outbox.source_seq
          )
      `).run(this.acknowledgedThrough);
    });
  }

  private compactJournal(): void {
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM runner_ipc_journal
        WHERE host_acked = 1 AND outbox_source_seq <= ?
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

async function assertExistingRunnerDatabase(databasePath: string): Promise<void> {
  if (!databasePath || databasePath === ":memory:") {
    throw new Error("runner event outbox requires a file-backed SQLite path");
  }
  let info;
  try {
    info = await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`runner event outbox SQLite file is missing: ${databasePath}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!info.isFile() || info.size === 0) {
    throw new Error(`runner event outbox SQLite file is empty or invalid: ${databasePath}`);
  }
}
