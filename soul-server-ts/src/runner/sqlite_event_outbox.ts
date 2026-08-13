// This legacy store intentionally remains a single module: its append, journal,
// checkpoint, ACK, and quarantine operations share one SQLite connection and
// transaction-coupled prepared-statement state. Splitting those invariants during
// the incident fix would create a wider persistence-boundary migration.
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
  appendEventOutboxQuarantine,
  type EventOutboxQuarantineInput,
  type EventOutboxQuarantineResult,
} from "../upstream/event_outbox_quarantine.js";
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
import {
  claimRunnerIntervention,
  finishRunnerExecutionAndIntervention,
  markRunnerInterventionAmbiguous,
  migrateRunnerInterventionInboxV9,
  readPendingRunnerInterventions,
  resolveRunnerInterventionAmbiguity,
  stageRunnerIntervention,
  type RunnerInterventionResolution,
} from "./sqlite_intervention_inbox.js";
import {
  ensureRunnerSqliteWal,
  openRunnerSqliteDatabase,
  openRunnerSqliteReadOnlyDatabase,
  requireRunnerSqliteWal,
  withRunnerSqliteBusyRetry,
  withRunnerSqliteTransaction,
  type RunnerSqliteTransactionOptions,
  type RunnerSqliteTransactionObserver,
} from "./runner_sqlite_connection.js";

export type { RunnerBootstrapInput, RunnerBootstrapRecord, RunnerResumeMaterial }
  from "./sqlite_event_outbox_schema.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;

export interface RunnerSqliteEventOutboxOptions {
  sessionId?: string;
  transactionObserver?: RunnerSqliteTransactionObserver;
}

export class RunnerSqliteEventOutbox {
  private readonly appendListeners = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly database: SqliteDatabase,
    readonly databasePath: string,
    private bootstrap: RunnerBootstrapRecord | null,
    private acknowledgedThrough: number,
    private readonly options: RunnerSqliteEventOutboxOptions,
  ) {}

  static async open(
    databasePath: string,
    options: RunnerSqliteEventOutboxOptions = {},
  ): Promise<RunnerSqliteEventOutbox> {
    await assertExistingRunnerDatabase(databasePath);
    return await RunnerSqliteEventOutbox.openDatabase(databasePath, options);
  }

  static async create(
    databasePath: string,
    options: RunnerSqliteEventOutboxOptions = {},
  ): Promise<RunnerSqliteEventOutbox> {
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
    return await RunnerSqliteEventOutbox.openDatabase(databasePath, options);
  }

  static async openReadOnly(
    databasePath: string,
    options: RunnerSqliteEventOutboxOptions = {},
  ): Promise<RunnerSqliteEventOutbox> {
    await assertExistingRunnerDatabase(databasePath);
    const database = openRunnerSqliteReadOnlyDatabase(databasePath);
    try {
      requireRunnerSqliteWal(database);
      const version = readUserVersion(database);
      if (version !== RUNNER_EVENT_OUTBOX_SCHEMA_VERSION) {
        throw new Error(
          `runner event outbox schema version ${version} requires writer migration`,
        );
      }
      const recovered = recover(database);
      return new RunnerSqliteEventOutbox(
        database,
        databasePath,
        recovered.bootstrap,
        recovered.ackedThrough,
        options,
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private static async openDatabase(
    databasePath: string,
    options: RunnerSqliteEventOutboxOptions,
  ): Promise<RunnerSqliteEventOutbox> {
    const database = openRunnerSqliteDatabase(databasePath);
    try {
      await chmod(databasePath, 0o600);
      const recovered = await withRunnerSqliteBusyRetry(() => {
        ensureRunnerSqliteWal(database);
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
        const next = recover(database, {
          migrateLegacyAckCheckpoint: version < RUNNER_EVENT_OUTBOX_SCHEMA_VERSION,
        });
        migrateRunnerInterventionInboxV9(database, version);
        return next;
      });
      return new RunnerSqliteEventOutbox(
        database,
        databasePath,
        recovered.bootstrap,
        recovered.ackedThrough,
        options,
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

    const durable = await this.transaction("initialize_bootstrap", () => {
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
    await this.transaction("append_event", () => {
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

  async stageIntervention(input: {
    interventionId: string;
    message: Record<string, unknown>;
    event?: EventOutboxAppendInput;
    queued: boolean;
    queuedAt: string;
  }): Promise<{ eventSourceSeq: number | null; queuePosition: number }> {
    const bootstrap = this.requireBootstrap();
    const staged = await stageRunnerIntervention(
      this.database,
      (operation) => this.transaction("stage_intervention", operation),
      bootstrap,
      input,
    );
    for (const listener of this.appendListeners) listener();
    return staged;
  }

  async readPendingInterventions(): Promise<Array<{
    interventionId: string;
    message: Record<string, unknown>;
  }>> {
    this.requireOpen();
    return await readPendingRunnerInterventions(this.database);
  }

  async claimIntervention(interventionId: string, commandId: string): Promise<boolean> {
    this.requireOpen();
    return await claimRunnerIntervention(
      this.database,
      (operation) => this.transaction("claim_intervention", operation),
      interventionId,
      commandId,
    );
  }

  async markInterventionAmbiguous(interventionId: string, commandId: string): Promise<void> {
    this.requireOpen();
    await markRunnerInterventionAmbiguous(
      this.database,
      (operation) => this.transaction("mark_intervention_ambiguous", operation),
      interventionId,
      commandId,
    );
  }

  async resolveAmbiguousIntervention(
    interventionId: string,
    resolution: RunnerInterventionResolution,
  ): Promise<void> {
    this.requireOpen();
    await resolveRunnerInterventionAmbiguity(
      this.database,
      (operation) => this.transaction("resolve_intervention_ambiguity", operation),
      interventionId,
      resolution,
    );
  }

  async finishExecution(input: {
    commandId: string;
    interventionId?: string;
    state: "completed" | "failed";
    progressedAt: string;
    terminalError: { code: string; message: string } | null;
  }): Promise<void> {
    this.requireOpen();
    await finishRunnerExecutionAndIntervention(
      this.database,
      (operation) => this.transaction("finish_execution", operation),
      input,
    );
  }

  /**
   * Atomically appends one orch-bound event and a payload-free IPC ordering
   * reference. The journal never stores domain payload or metadata; replay
   * reconstructs the frame from runner_event_outbox.
   */
  async appendEngineFrame(
    input: EventOutboxAppendInput,
    frame: Extract<RunnerEventFrame, { kind: "engine_event" }>,
    backendSessionRotation?: {
      expectedBackendSessionId: string;
      backendSessionId: string;
    },
  ): Promise<EventOutboxRecord & { ipc_frame_seq: number }> {
    const bootstrap = this.requireBootstrap();
    validateRunnerAppendInput(input);
    if (input.session_id !== bootstrap.session_id) {
      throw new Error("runner event session_id differs from bootstrap record");
    }
    const rotationEffect = input.session_effect?.kind === "rotate_backend_session_id"
      ? input.session_effect
      : undefined;
    if (
      backendSessionRotation
      && (
        rotationEffect?.expected_backend_session_id
          !== backendSessionRotation.expectedBackendSessionId
        || rotationEffect.backend_session_id !== backendSessionRotation.backendSessionId
      )
    ) {
      throw new Error("runner backend session rotation differs from event session effect");
    }
    if (!backendSessionRotation && rotationEffect) {
      throw new Error("runner backend session rotation effect requires atomic bootstrap rotation");
    }
    const parsedFrame = engineEventFrame(frame.payload, frame.metadata);
    if (JSON.stringify(parsedFrame.payload) !== JSON.stringify(input.payload)) {
      throw new Error("runner frame payload differs from durable event payload");
    }

    let record!: EventOutboxRecord;
    let frameSeq!: number;
    let rotatedBootstrap: RunnerBootstrapRecord | undefined;
    await this.transaction("append_engine_frame", () => {
      if (backendSessionRotation) {
        if (
          !backendSessionRotation.expectedBackendSessionId
          || !backendSessionRotation.backendSessionId
          || backendSessionRotation.expectedBackendSessionId
            === backendSessionRotation.backendSessionId
        ) {
          throw new Error("runner backend session rotation requires distinct non-empty IDs");
        }
        const row = this.database.prepare(`
          SELECT * FROM runner_event_outbox
          WHERE record_kind = 'bootstrap'
        `).get() as unknown as RunnerEventOutboxRow | undefined;
        if (!row) throw new Error("runner bootstrap record required before backend session rotation");
        const current = runnerRowToBootstrap(row);
        if (
          current.payload.backend_session_id
          !== backendSessionRotation.expectedBackendSessionId
        ) {
          throw new Error("runner backend session rotation expected backend session ID mismatch");
        }
        const rotatedUnsigned = {
          stream_id: current.stream_id,
          source_seq: current.source_seq,
          session_id: current.session_id,
          event_type: current.event_type,
          payload: {
            ...current.payload,
            backend_session_id: backendSessionRotation.backendSessionId,
          },
          searchable_text: current.searchable_text,
          created_at: current.created_at,
          semantic_dedupe_key: current.semantic_dedupe_key,
          session_effect: current.session_effect,
        };
        rotatedBootstrap = {
          ...rotatedUnsigned,
          payload_hash: computeEventOutboxPayloadHash(rotatedUnsigned),
        };
        this.database.prepare(`
          UPDATE runner_event_outbox
          SET payload_json = ?, payload_hash = ?
          WHERE record_kind = 'bootstrap' AND source_seq = 1
        `).run(
          JSON.stringify(rotatedBootstrap.payload),
          rotatedBootstrap.payload_hash,
        );
      }
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
    if (rotatedBootstrap) this.bootstrap = rotatedBootstrap;
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
    await this.transaction("acknowledge_host_frame", () => {
      this.database.prepare(`
        UPDATE runner_ipc_journal SET host_acked = 1
        WHERE frame_seq = ?
      `).run(frameSeq);
    });
    await this.compactJournal();
    await this.compactIfNeeded();
  }

  async recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): Promise<void> {
    this.requireOpen();
    await recordRunnerHostCallApplied(
      this.database,
      input,
      this.transactionOptions("record_host_call_applied"),
    );
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
    await acknowledgeRunnerHostCall(
      this.database,
      correlationId,
      this.transactionOptions("acknowledge_host_call"),
    );
  }

  async readBatch(maxEvents = EVENT_OUTBOX_MAX_BATCH_EVENTS): Promise<EventOutboxBatch | null> {
    this.requireOpen();
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) return null;
    this.acknowledgedThrough = readAcknowledgedThrough(this.database);
    return this.readBatchAfter(this.acknowledgedThrough, maxEvents);
  }

  async readBatchAfter(
    acknowledgedThrough: number,
    maxEvents = EVENT_OUTBOX_MAX_BATCH_EVENTS,
  ): Promise<EventOutboxBatch | null> {
    this.requireOpen();
    assertAcknowledgedThrough(acknowledgedThrough);
    assertBatchEventLimit(maxEvents);
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) return null;
    const rows = this.database.prepare(`
      SELECT * FROM runner_event_outbox
      WHERE record_kind = 'event' AND source_seq > ?
      ORDER BY source_seq
      LIMIT ?
    `).all(acknowledgedThrough, maxEvents) as unknown as RunnerEventOutboxRow[];
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

  async readLatestPendingRecord(): Promise<EventOutboxRecord | null> {
    this.requireOpen();
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) return null;
    this.acknowledgedThrough = readAcknowledgedThrough(this.database);
    return this.readLatestPendingRecordAfter(this.acknowledgedThrough);
  }

  async readLatestPendingRecordAfter(
    acknowledgedThrough: number,
  ): Promise<EventOutboxRecord | null> {
    this.requireOpen();
    assertAcknowledgedThrough(acknowledgedThrough);
    if (!this.refreshBootstrap()) return null;
    const row = this.database.prepare(`
      SELECT * FROM runner_event_outbox
      WHERE record_kind = 'event' AND source_seq > ?
      ORDER BY source_seq DESC
      LIMIT 1
    `).get(acknowledgedThrough) as unknown as RunnerEventOutboxRow | undefined;
    return row ? runnerRowToRecord(row) : null;
  }

  latestDurableSourceSeq(): number {
    this.requireOpen();
    return latestSequence(this.database);
  }

  hasDurableRecords(): boolean {
    this.requireOpen();
    return rowCount(this.database) > 0;
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
    const durableCursor = await this.transaction("acknowledge_event_batch", () => {
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
      await this.compactJournal();
      await this.compactIfNeeded();
    }
  }

  async quarantineHead(
    input: EventOutboxQuarantineInput,
  ): Promise<EventOutboxQuarantineResult> {
    const bootstrap = this.requireBootstrap();
    if (input.record.stream_id !== bootstrap.stream_id) {
      throw new Error("runner event outbox quarantine stream_id mismatch");
    }
    this.acknowledgedThrough = readAcknowledgedThrough(this.database);
    const expectedHead = this.acknowledgedThrough + 1;
    if (input.record.source_seq !== expectedHead) {
      throw new Error("runner event outbox quarantine target is not the durable head");
    }
    const durable = await this.readRecord(expectedHead);
    if (!durable || durable.payload_hash !== input.record.payload_hash) {
      throw new Error("runner event outbox quarantine target differs from durable head");
    }
    const result = await appendEventOutboxQuarantine(dirname(this.databasePath), input);
    await this.acknowledge(bootstrap.stream_id, expectedHead);
    return result;
  }

  /** Final-ACK evidence used by release GC; true is fail-safe retention. */
  async hasPendingDurableWork(
    acknowledgedThrough = readAcknowledgedThrough(this.database),
  ): Promise<boolean> {
    this.requireOpen();
    assertAcknowledgedThrough(acknowledgedThrough);
    const bootstrap = this.refreshBootstrap();
    if (!bootstrap) return true;
    const pendingEvent = this.database.prepare(`
      SELECT 1 FROM runner_event_outbox
      WHERE record_kind = 'event' AND source_seq > ?
      LIMIT 1
    `).get(acknowledgedThrough);
    if (pendingEvent) return true;
    const pendingIpc = this.database.prepare(`
      SELECT 1 FROM runner_ipc_journal WHERE host_acked = 0 LIMIT 1
    `).get();
    if (pendingIpc !== undefined) return true;
    return this.database.prepare(`
      SELECT 1 FROM runner_intervention_inbox AS inbox
      WHERE inbox.application_state <> 'claimed'
         OR NOT EXISTS (
           SELECT 1 FROM runner_event_outbox AS lifecycle
           WHERE lifecycle.record_kind = 'bootstrap'
             AND lifecycle.execution_state = 'completed'
             AND lifecycle.execution_command_id = inbox.claimed_execution_command_id
           UNION ALL
           SELECT 1 FROM runner_prebootstrap_lifecycle AS lifecycle
           WHERE lifecycle.singleton = 1
             AND lifecycle.execution_state = 'completed'
             AND lifecycle.execution_command_id = inbox.claimed_execution_command_id
         )
      LIMIT 1
    `).get() !== undefined;
  }

  async compactAppliedHostCallsForTerminalRecovery(): Promise<void> {
    this.requireOpen();
    await this.transaction("compact_applied_host_calls", () => {
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

  private async compactIfNeeded(): Promise<void> {
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
    await this.transaction("compact_event_outbox", () => {
      this.database.prepare(`
        DELETE FROM runner_event_outbox
        WHERE record_kind = 'event' AND source_seq <= ?
          AND NOT EXISTS (
            SELECT 1 FROM runner_ipc_journal
            WHERE outbox_source_seq = runner_event_outbox.source_seq
          )
          AND NOT EXISTS (
            SELECT 1 FROM runner_intervention_inbox
            WHERE event_source_seq = runner_event_outbox.source_seq
          )
      `).run(this.acknowledgedThrough);
    });
  }

  private async compactJournal(): Promise<void> {
    await this.transaction("compact_ipc_journal", () => {
      this.database.prepare(`
        DELETE FROM runner_ipc_journal
        WHERE host_acked = 1 AND outbox_source_seq <= ?
      `).run(this.acknowledgedThrough);
    });
  }

  private async transaction<T>(transactionLabel: string, operation: () => T): Promise<T> {
    this.requireOpen();
    return await withRunnerSqliteTransaction(
      this.database,
      operation,
      this.transactionOptions(transactionLabel),
    );
  }

  private transactionOptions(transactionLabel: string): RunnerSqliteTransactionOptions {
    return {
      transactionLabel: `event_outbox.${transactionLabel}`,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      ...(this.options.transactionObserver
        ? { observer: this.options.transactionObserver }
        : {}),
    };
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

function assertAcknowledgedThrough(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("runner event outbox acknowledged_through is invalid");
  }
}

function assertBatchEventLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > EVENT_OUTBOX_MAX_BATCH_EVENTS) {
    throw new Error(`event outbox batch event limit must be 1-${EVENT_OUTBOX_MAX_BATCH_EVENTS}`);
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
