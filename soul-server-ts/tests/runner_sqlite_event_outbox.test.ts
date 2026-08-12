import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVENT_OUTBOX_COMPACT_BYTES,
  EVENT_OUTBOX_COMPACT_ROWS,
  EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES,
  computeEventOutboxPayloadHash,
  type EventOutboxAppendInput,
  type EventOutboxBatch,
} from "../src/upstream/event_outbox.js";
import { EventOutboxPump } from "../src/upstream/event_outbox_pump.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapInput,
} from "../src/runner/sqlite_event_outbox.js";
import { inspectRunnerOutboxCopy } from "../src/runner/runner_outbox_inspector.js";
import { computeRunnerAckCheckpointHash } from "../src/runner/sqlite_event_outbox_database.js";
import {
  readRunnerLifecycleSummary,
  runnerLifecycleSummaryPath,
  RunnerSqliteLifecycle,
} from "../src/runner/sqlite_runner_lifecycle.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerSqliteEventOutbox", () => {
  it("opens only existing non-empty databases and never recreates missing lineage", async () => {
    const missingPath = await temporaryDatabasePath();
    await expect(RunnerSqliteEventOutbox.open(missingPath)).rejects.toThrow(
      "SQLite file is missing",
    );
    await writeFile(missingPath, "");
    await expect(RunnerSqliteEventOutbox.open(missingPath)).rejects.toThrow(
      "SQLite file is empty or invalid",
    );
    await expect(RunnerSqliteEventOutbox.create(missingPath)).rejects.toThrow(
      "empty SQLite file",
    );
  });

  it("uses WAL with one event ledger, one IPC journal, and a payload-free pre-bootstrap lease", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    outbox.close();

    expect(inspectRunnerOutboxCopy(path)).toMatchObject({
      status: "healthy",
      ackedThrough: null,
      latestSequence: 0,
      retainedEventCount: 0,
      unacknowledgedEventCount: 0,
    });

    const database = new DatabaseSync(path);
    try {
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      const tables = database.prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string; sql: string }>;
      expect(tables.map((table) => table.name)).toEqual([
        "runner_event_outbox",
        "runner_prebootstrap_lifecycle",
        "runner_intervention_inbox",
        "runner_ipc_journal",
      ]);
      const outboxTable = tables.find((table) => table.name === "runner_event_outbox")!;
      const lifecycleTable = tables.find(
        (table) => table.name === "runner_prebootstrap_lifecycle",
      )!;
      const journalTable = tables.find((table) => table.name === "runner_ipc_journal")!;
      const interventionTable = tables.find(
        (table) => table.name === "runner_intervention_inbox",
      )!;
      expect(outboxTable.sql).toContain("source_seq INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(outboxTable.sql).toContain("runner_metadata_json");
      expect(outboxTable.sql).toContain("execution_command_id");
      expect(outboxTable.sql).toContain("progress_seq");
      expect(outboxTable.sql).toContain("liveness_at");
      expect(outboxTable.sql).toContain("in_flight_tools_json");
      expect(outboxTable.sql).toContain("terminal_error_json");
      expect(journalTable.sql).toContain("frame_seq INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(journalTable.sql).toContain("outbox_source_seq INTEGER UNIQUE");
      expect(journalTable.sql).toContain("correlation_id TEXT UNIQUE");
      expect(journalTable.sql).not.toMatch(/payload|metadata|session_effect/);
      expect(lifecycleTable.sql).toContain("execution_command_id TEXT NOT NULL");
      expect(lifecycleTable.sql).toContain("liveness_at");
      expect(lifecycleTable.sql).toContain("in_flight_tools_json");
      expect(lifecycleTable.sql).not.toMatch(/payload|metadata|session_effect/);
      expect(interventionTable.sql).toContain("intervention_id TEXT PRIMARY KEY");
      expect(interventionTable.sql).toContain("event_source_seq INTEGER UNIQUE");
      expect(interventionTable.sql).toContain("claimed_execution_command_id TEXT");
      expect(interventionTable.sql).toContain("application_state TEXT NOT NULL");
      expect(outboxTable.sql).toContain("STRICT");
      expect(lifecycleTable.sql).toContain("STRICT");
      expect(journalTable.sql).toContain("STRICT");
    } finally {
      database.close();
    }
  });

  it("atomically persists an intervention receipt and restart-safe next-turn inbox entry", async () => {
    const path = await temporaryDatabasePath();
    const writer = await RunnerSqliteEventOutbox.create(path);
    await writer.initializeBootstrap(bootstrapInput());

    const stage = {
      interventionId: "intervention-1",
      message: { text: "after restart", user: "soak" },
      event: {
        session_id: "session-a",
        event_type: "intervention_sent",
        payload: { type: "intervention_sent", text: "after restart", user: "soak" },
        searchable_text: "after restart",
        created_at: "2026-08-11T00:00:02.000Z",
        semantic_dedupe_key: null,
        session_effect: null,
      },
      queued: true,
      queuedAt: "2026-08-11T00:00:02.000Z",
    };
    await expect(writer.stageIntervention(stage)).resolves.toEqual({
      eventSourceSeq: 2,
      queuePosition: 1,
    });
    await expect(writer.stageIntervention(stage)).resolves.toEqual({
      eventSourceSeq: 2,
      queuePosition: 1,
    });
    writer.close();

    const recovered = await RunnerSqliteEventOutbox.open(path);
    await expect(recovered.readRecord(2)).resolves.toMatchObject({
      event_type: "intervention_sent",
    });
    await expect(recovered.readPendingInterventions()).resolves.toEqual([{
      interventionId: "intervention-1",
      message: { text: "after restart", user: "soak" },
    }]);

    const lifecycle = RunnerSqliteLifecycle.open(path, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-followup",
      progressedAt: "2026-08-11T00:00:03.000Z",
    });
    await expect(
      recovered.claimIntervention("intervention-1", "execute-followup"),
    ).resolves.toBe(true);
    await expect(recovered.readPendingInterventions()).resolves.toEqual([]);
    await recovered.finishExecution({
      commandId: "execute-followup",
      interventionId: "intervention-1",
      state: "completed",
      progressedAt: "2026-08-11T00:00:04.000Z",
      terminalError: null,
    });
    await expect(recovered.readPendingInterventions()).resolves.toEqual([]);
    lifecycle.close();
    recovered.close();
  });

  it("stops an ambiguous intervention after engine failure instead of automatic retry", async () => {
    const outbox = await createOutbox();
    await outbox.stageIntervention({
      interventionId: "retry-after-failure",
      message: { text: "do not lose me", user: "soak" },
      queued: true,
      queuedAt: "2026-08-11T00:00:02.000Z",
    });
    const lifecycle = RunnerSqliteLifecycle.open(outbox.databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-failed",
      progressedAt: "2026-08-11T00:00:03.000Z",
    });
    await expect(
      outbox.claimIntervention("retry-after-failure", "execute-failed"),
    ).resolves.toBe(true);
    await expect(outbox.readPendingInterventions()).resolves.toEqual([]);

    await outbox.finishExecution({
      commandId: "execute-failed",
      interventionId: "retry-after-failure",
      state: "failed",
      progressedAt: "2026-08-11T00:00:04.000Z",
      terminalError: { code: "execution_failed", message: "boom" },
    });
    await expect(outbox.readPendingInterventions()).rejects.toThrow(
      "runner intervention application outcome is ambiguous: retry-after-failure",
    );
    expect(lifecycle.read()).toMatchObject({
      execution_command_id: "execute-failed",
      execution_state: "failed",
    });
    lifecycle.close();
    outbox.close();
  });

  it("never replays a completed execution whose legacy inbox cleanup was interrupted", async () => {
    const outbox = await createOutbox();
    await outbox.stageIntervention({
      interventionId: "completed-but-retained",
      message: { text: "apply once", user: "soak" },
      queued: true,
      queuedAt: "2026-08-11T00:00:02.000Z",
    });
    const lifecycle = RunnerSqliteLifecycle.open(outbox.databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-completed",
      progressedAt: "2026-08-11T00:00:03.000Z",
    });
    await outbox.claimIntervention("completed-but-retained", "execute-completed");

    // Models the old split commit: lifecycle reached completed but inbox delete
    // did not. Recovery must treat completed as the durable apply receipt.
    lifecycle.finish(
      "execute-completed",
      "completed",
      "2026-08-11T00:00:04.000Z",
    );

    await expect(outbox.readPendingInterventions()).resolves.toEqual([]);
    const database = new DatabaseSync(outbox.databasePath);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM runner_intervention_inbox",
    ).get()).toEqual({ count: 0 });
    database.close();
    lifecycle.close();
    outbox.close();
  });

  it("stops a claimed intervention that has no matching running lifecycle", async () => {
    const outbox = await createOutbox();
    await outbox.stageIntervention({
      interventionId: "claimed-before-lifecycle",
      message: { text: "uncertain dispatch", user: "soak" },
      queued: true,
      queuedAt: "2026-08-11T00:00:02.000Z",
    });
    const lifecycle = RunnerSqliteLifecycle.open(outbox.databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "previous-execution",
      progressedAt: "2026-08-11T00:00:03.000Z",
    });
    lifecycle.finish(
      "previous-execution",
      "completed",
      "2026-08-11T00:00:04.000Z",
    );
    await outbox.claimIntervention("claimed-before-lifecycle", "uncertain-execution");

    await expect(outbox.readPendingInterventions()).rejects.toThrow(
      "runner intervention application outcome is ambiguous: claimed-before-lifecycle",
    );
    lifecycle.close();
    outbox.close();
  });

  it("rolls back terminal lifecycle when intervention commit fails", async () => {
    const outbox = await createOutbox();
    await outbox.stageIntervention({
      interventionId: "atomic-terminal",
      message: { text: "one commit", user: "soak" },
      queued: true,
      queuedAt: "2026-08-11T00:00:02.000Z",
    });
    const lifecycle = RunnerSqliteLifecycle.open(outbox.databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-atomic",
      progressedAt: "2026-08-11T00:00:03.000Z",
    });
    await outbox.claimIntervention("atomic-terminal", "execute-atomic");
    const fault = new DatabaseSync(outbox.databasePath);
    fault.exec(`
      CREATE TRIGGER fail_intervention_completion
      BEFORE DELETE ON runner_intervention_inbox
      BEGIN
        SELECT RAISE(ABORT, 'forced intervention completion failure');
      END;
    `);
    fault.close();

    await expect(outbox.finishExecution({
      commandId: "execute-atomic",
      interventionId: "atomic-terminal",
      state: "completed",
      progressedAt: "2026-08-11T00:00:04.000Z",
      terminalError: null,
    })).rejects.toThrow("forced intervention completion failure");
    expect(lifecycle.read()).toMatchObject({
      execution_command_id: "execute-atomic",
      execution_state: "running",
    });
    const verified = new DatabaseSync(outbox.databasePath);
    expect(verified.prepare(`
      SELECT application_state, claimed_execution_command_id
      FROM runner_intervention_inbox WHERE intervention_id = 'atomic-terminal'
    `).get()).toEqual({
      application_state: "claimed",
      claimed_execution_command_id: "execute-atomic",
    });
    verified.close();
    lifecycle.close();
    outbox.close();
  });

  it("rejects a zero-byte database created by a concurrent opener", async () => {
    const path = await temporaryDatabasePath();
    const worker = new Worker(`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData);
      database.exec("BEGIN EXCLUSIVE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
      }, 150);
    `, { eval: true, workerData: path });
    const workerExit = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => code === 0
        ? resolve()
        : reject(new Error(`SQLite lock worker exited with code ${code}`)));
    });
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));

    try {
      await expect(RunnerSqliteEventOutbox.create(path)).rejects.toThrow(
        "empty SQLite file",
      );
    } finally {
      await workerExit;
    }
  });

  it("makes the resume material the first durable record and events start at seq 2", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    const event = await outbox.append(eventInput("one"));

    expect(bootstrap).toMatchObject({
      source_seq: 1,
      session_id: "session-a",
      event_type: "runner_bootstrap",
      payload: bootstrapInput().resume,
    });
    expect(bootstrap.payload_hash).toBe(computeEventOutboxPayloadHash(unsigned(bootstrap)));
    expect(event).toMatchObject({
      stream_id: bootstrap.stream_id,
      source_seq: 2,
      session_id: "session-a",
    });
    expect(outbox.ackedSeq).toBe(1);

    outbox.close();
    const reopened = await RunnerSqliteEventOutbox.create(path);
    expect(await reopened.readBootstrap()).toEqual(bootstrap);
    expect(await reopened.readBatch()).toEqual({
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: bootstrap.stream_id,
      first_seq: 2,
      events: [event],
    });
    reopened.close();
  });

  it("requires bootstrap before append and keeps initialization idempotent", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);

    await expect(outbox.append(eventInput("too early")))
      .rejects.toThrow("runner bootstrap record required before event append");
    const first = await outbox.initializeBootstrap(bootstrapInput());
    await expect(outbox.initializeBootstrap(bootstrapInput())).resolves.toEqual(first);
    await expect(outbox.initializeBootstrap({
      ...bootstrapInput(),
      resume: { ...bootstrapInput().resume, code_sha: "different" },
    })).rejects.toThrow("runner bootstrap record conflicts with durable record");
    outbox.close();
  });

  it("exposes final-ACK evidence across outbox and IPC journal for release GC", async () => {
    const outbox = await RunnerSqliteEventOutbox.create(await temporaryDatabasePath());
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    expect(await outbox.hasPendingDurableWork()).toBe(false);

    const event = await outbox.append(eventInput("pending"));
    expect(await outbox.hasPendingDurableWork()).toBe(true);
    await outbox.acknowledge(bootstrap.stream_id, event.source_seq);
    expect(await outbox.hasPendingDurableWork()).toBe(false);

    await outbox.recordHostCallApplied({
      correlationId: "host-call-a",
      service: "session_store",
      operation: "append",
      createdAt: "2026-08-11T01:00:00.000Z",
    });
    expect(await outbox.hasPendingDurableWork()).toBe(true);
    await outbox.acknowledgeHostCall("host-call-a");
    expect(await outbox.hasPendingDurableWork()).toBe(false);
    outbox.close();
  });

  it("separates process liveness from actual progress and explicit tool leases", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    const lifecycle = RunnerSqliteLifecycle.open(path);

    expect(lifecycle.read()).toBeNull();
    expect(lifecycle.begin({
      pid: 4123,
      commandId: "execute-a",
      progressedAt: "2026-08-11T01:00:00.000Z",
    })).toMatchObject({
      session_id: "session-a",
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: "running",
      progress_seq: 1,
      progress_at: "2026-08-11T01:00:00.000Z",
      liveness_at: "2026-08-11T01:00:00.000Z",
      in_flight_tools: [],
      terminal_error: null,
    });
    expect(lifecycle.liveness("execute-a", "2026-08-11T01:00:00.500Z"))
      .toMatchObject({
        progress_seq: 1,
        progress_at: "2026-08-11T01:00:00.000Z",
        liveness_at: "2026-08-11T01:00:00.500Z",
        in_flight_tools: [],
      });
    expect(lifecycle.toolStarted(
      "execute-a",
      "tool-long",
      "2026-08-11T01:00:00.750Z",
    )).toMatchObject({
      progress_seq: 2,
      progress_at: "2026-08-11T01:00:00.750Z",
      liveness_at: "2026-08-11T01:00:00.750Z",
      in_flight_tools: [{
        tool_use_id: "tool-long",
        started_at: "2026-08-11T01:00:00.750Z",
      }],
    });
    expect(lifecycle.toolStarted(
      "execute-a",
      "tool-long",
      "2026-08-11T01:00:00.800Z",
    )).toMatchObject({
      progress_seq: 2,
      progress_at: "2026-08-11T01:00:00.750Z",
      liveness_at: "2026-08-11T01:00:00.750Z",
      in_flight_tools: [{
        tool_use_id: "tool-long",
        started_at: "2026-08-11T01:00:00.750Z",
      }],
    });
    expect(lifecycle.liveness("execute-a", "2026-08-11T01:00:00.900Z"))
      .toMatchObject({
        progress_seq: 2,
        progress_at: "2026-08-11T01:00:00.750Z",
        liveness_at: "2026-08-11T01:00:00.900Z",
        in_flight_tools: [{
          tool_use_id: "tool-long",
          started_at: "2026-08-11T01:00:00.750Z",
        }],
      });
    expect(lifecycle.toolFinished(
      "execute-a",
      "tool-long",
      "2026-08-11T01:00:00.950Z",
    )).toMatchObject({
      progress_seq: 3,
      progress_at: "2026-08-11T01:00:00.950Z",
      liveness_at: "2026-08-11T01:00:00.950Z",
      in_flight_tools: [],
    });
    expect(lifecycle.progress("execute-a", "2026-08-11T01:00:01.000Z"))
      .toMatchObject({ progress_seq: 4, progress_at: "2026-08-11T01:00:01.000Z" });
    expect(lifecycle.finish(
      "execute-a",
      "completed",
      "2026-08-11T01:00:02.000Z",
    )).toMatchObject({ execution_state: "completed", progress_seq: 5 });
    await expect(readRunnerLifecycleSummary(path)).resolves.toMatchObject({
      session_id: "session-a",
      execution_state: "completed",
      progress_seq: 5,
      progress_at: "2026-08-11T01:00:02.000Z",
      liveness_at: "2026-08-11T01:00:02.000Z",
      in_flight_tools: [],
    });

    expect((await outbox.readBootstrap())?.payload_hash).toBe(bootstrap.payload_hash);
    expect(outbox.ackedSeq).toBe(1);
    lifecycle.close();
    outbox.close();
  });

  it("migrates v6 lifecycle storage and normalizes legacy summaries", async () => {
    const path = await temporaryDatabasePath();
    const initial = await RunnerSqliteEventOutbox.create(path);
    await initial.initializeBootstrap(bootstrapInput());
    initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE runner_event_outbox DROP COLUMN in_flight_tools_json;
      ALTER TABLE runner_event_outbox DROP COLUMN liveness_at;
      ALTER TABLE runner_prebootstrap_lifecycle DROP COLUMN in_flight_tools_json;
      ALTER TABLE runner_prebootstrap_lifecycle DROP COLUMN liveness_at;
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const migrated = await RunnerSqliteEventOutbox.create(path);
    migrated.close();
    const verified = new DatabaseSync(path);
    try {
      for (const table of ["runner_event_outbox", "runner_prebootstrap_lifecycle"]) {
        const rows = verified.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        const columns = rows.map((column) => column.name);
        expect(columns).toContain("liveness_at");
        expect(columns).toContain("in_flight_tools_json");
      }
      expect(verified.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    } finally {
      verified.close();
    }

    await writeFile(runnerLifecycleSummaryPath(path), JSON.stringify({
      session_id: "session-a",
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: "running",
      progress_seq: 1,
      progress_at: "2026-08-11T01:00:00.000Z",
      in_flight_tool_ids: ["legacy-tool"],
      terminal_error: null,
    }));
    await expect(readRunnerLifecycleSummary(path)).resolves.toMatchObject({
      progress_at: "2026-08-11T01:00:00.000Z",
      liveness_at: "2026-08-11T01:00:00.000Z",
      in_flight_tools: [{
        tool_use_id: "legacy-tool",
        started_at: "2026-08-11T01:00:00.000Z",
      }],
    });
  });

  it("migrates v8 claimed interventions to an explicit claimed application state", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    await outbox.initializeBootstrap(bootstrapInput());
    await outbox.stageIntervention({
      interventionId: "legacy-v8-claim",
      message: { text: "legacy claim", user: "soak" },
      queued: true,
      queuedAt: "2026-08-11T00:00:02.000Z",
    });
    const lifecycle = RunnerSqliteLifecycle.open(path, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-v8",
      progressedAt: "2026-08-11T00:00:03.000Z",
    });
    await outbox.claimIntervention("legacy-v8-claim", "execute-v8");
    lifecycle.close();
    outbox.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE runner_intervention_inbox DROP COLUMN application_state;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = await RunnerSqliteEventOutbox.open(path);
    await expect(migrated.readPendingInterventions()).resolves.toEqual([]);
    const verified = new DatabaseSync(path);
    expect(verified.prepare(`
      SELECT application_state, claimed_execution_command_id
      FROM runner_intervention_inbox WHERE intervention_id = 'legacy-v8-claim'
    `).get()).toEqual({
      application_state: "claimed",
      claimed_execution_command_id: "execute-v8",
    });
    expect(verified.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    verified.close();
    migrated.close();
  });

  it("records pre-bootstrap failure and promotes only the succeeding execution lease", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const lifecycle = RunnerSqliteLifecycle.open(path, "session-a");

    lifecycle.begin({
      pid: 4123,
      commandId: "execute-failed",
      progressedAt: "2026-08-11T01:00:00.000Z",
    });
    lifecycle.finish(
      "execute-failed",
      "failed",
      "2026-08-11T01:00:01.000Z",
      { code: "execution_failed", message: "backend ID unavailable" },
    );
    expect(await outbox.readBootstrap()).toBeNull();
    expect(lifecycle.read()).toMatchObject({
      execution_command_id: "execute-failed",
      execution_state: "failed",
    });

    lifecycle.begin({
      pid: 4123,
      commandId: "execute-next",
      progressedAt: "2026-08-11T01:00:02.000Z",
    });
    await outbox.initializeBootstrap({
      ...bootstrapInput(),
      resume: {
        ...bootstrapInput().resume,
        backend_session_id: "backend-session-next",
      },
    });
    lifecycle.begin({
      pid: 4123,
      commandId: "execute-next",
      progressedAt: "2026-08-11T01:00:03.000Z",
    });

    expect(lifecycle.read()).toMatchObject({
      execution_command_id: "execute-next",
      execution_state: "running",
      terminal_error: null,
    });
    const database = new DatabaseSync(path);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM runner_prebootstrap_lifecycle",
    ).get()).toEqual({ count: 0 });
    database.close();

    lifecycle.close();
    outbox.close();
  });

  it("rejects stale lifecycle writers and records a loud reap error", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    await outbox.initializeBootstrap(bootstrapInput());
    const lifecycle = RunnerSqliteLifecycle.open(path);
    lifecycle.begin({
      pid: 5001,
      commandId: "execute-current",
      progressedAt: "2026-08-11T01:00:00.000Z",
    });

    expect(() => lifecycle.progress(
      "execute-stale",
      "2026-08-11T01:00:01.000Z",
    )).toThrow("runner lifecycle command mismatch");
    expect(lifecycle.reap(
      "execute-current",
      "2026-08-11T01:02:00.000Z",
      { code: "lease_expired", message: "runner made no progress" },
    )).toMatchObject({
      execution_state: "reaped",
      terminal_error: { code: "lease_expired", message: "runner made no progress" },
    });

    lifecycle.close();
    outbox.close();
  });

  it("keeps bootstrap initialization idempotent across two SQLite connections", async () => {
    const path = await temporaryDatabasePath();
    const first = await RunnerSqliteEventOutbox.create(path);
    const second = await RunnerSqliteEventOutbox.create(path);

    const durable = await first.initializeBootstrap(bootstrapInput());
    await expect(second.initializeBootstrap(bootstrapInput())).resolves.toEqual(durable);
    expect(second.streamId).toBe(durable.stream_id);

    first.close();
    second.close();
  });

  it("treats explicit null resume identifiers as a final no-resume state", async () => {
    const outbox = await RunnerSqliteEventOutbox.create(await temporaryDatabasePath());
    const input: RunnerBootstrapInput = {
      ...bootstrapInput(),
      resume: {
        ...bootstrapInput().resume,
        backend_session_id: null,
        codex_home: null,
        rollout_root: null,
      },
    };

    const durable = await outbox.initializeBootstrap(input);

    expect(durable.payload).toEqual(input.resume);
    expect((await outbox.readBootstrap())?.payload).toEqual(input.resume);
    await expect(outbox.initializeBootstrap({
      ...input,
      resume: { ...input.resume, backend_session_id: "late-backend-session" },
    })).rejects.toThrow("runner bootstrap record conflicts with durable record");
    outbox.close();
  });

  it.each([
    ["function", { nested: () => undefined }],
    ["Symbol", { nested: Symbol("not-json") }],
    ["Date", { nested: new Date("2026-08-11T00:00:00.000Z") }],
    ["Buffer", { nested: Buffer.from("not-json") }],
    ["class instance", { nested: new (class ResumeHandle {})() }],
  ])("rejects %s values at the durable JSON boundary", async (_kind, payload) => {
    const outbox = await createOutbox();

    await expect(outbox.append({ ...eventInput("invalid"), payload }))
      .rejects.toThrow(/JSON/);
    outbox.close();
  });

  it("applies the shared JSON contract to resume material and session effects", async () => {
    const path = await temporaryDatabasePath();
    const uninitialized = await RunnerSqliteEventOutbox.create(path);
    const resumeWithHandle = {
      ...bootstrapInput().resume,
      process_local_handle: () => undefined,
    };

    await expect(uninitialized.initializeBootstrap({
      ...bootstrapInput(),
      resume: resumeWithHandle,
    })).rejects.toThrow(/JSON contract/);
    await uninitialized.initializeBootstrap(bootstrapInput());
    await expect(uninitialized.append({
      ...eventInput("invalid effect"),
      session_effect: {
        kind: "append_metadata",
        entry: { process_local_handle: () => undefined },
        updated_at: "2026-08-11T00:00:01.000Z",
      },
    })).rejects.toThrow(/JSON contract/);
    uninitialized.close();
  });

  it("rejects events for a different session than the bootstrap record", async () => {
    const outbox = await createOutbox();

    await expect(outbox.append({ ...eventInput("wrong"), session_id: "session-b" }))
      .rejects.toThrow("runner event session_id differs from bootstrap record");
    outbox.close();
  });

  it("reserves runner_bootstrap for the local first record", async () => {
    const outbox = await createOutbox();

    await expect(outbox.append({ ...eventInput("wrong kind"), event_type: "runner_bootstrap" }))
      .rejects.toThrow("runner_bootstrap is reserved for the first durable record");
    outbox.close();
  });

  it("mirrors the Phase 11 64-event batch and durable ACK cursor contract", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    const records = [];
    for (let index = 0; index < 65; index += 1) {
      records.push(await outbox.append(eventInput(String(index))));
    }

    const first = await outbox.readBatch();
    expect(first?.events).toHaveLength(64);
    expect(first?.first_seq).toBe(2);
    expect(first?.events.at(-1)?.source_seq).toBe(65);
    await outbox.acknowledge(bootstrap.stream_id, 65);
    expect(outbox.ackedSeq).toBe(65);
    expect((await outbox.readBatch())?.events.map((record) => record.source_seq)).toEqual([66]);

    outbox.close();
    const reopened = await RunnerSqliteEventOutbox.create(path);
    expect(reopened.streamId).toBe(bootstrap.stream_id);
    expect(reopened.ackedSeq).toBe(65);
    expect((await reopened.readBatch())?.events).toEqual([records.at(-1)]);
    reopened.close();
  });

  it("rejects stream-mismatched, invalid, and beyond-durable ACK cursors", async () => {
    const outbox = await createOutbox();
    const record = await outbox.append(eventInput("one"));

    await expect(outbox.acknowledge("wrong-stream", record.source_seq))
      .rejects.toThrow("event outbox ACK stream_id mismatch");
    await expect(outbox.acknowledge(outbox.streamId, 0))
      .rejects.toThrow("event outbox ACK cursor must be a positive integer");
    await expect(outbox.acknowledge(outbox.streamId, record.source_seq + 1))
      .rejects.toThrow("event outbox ACK exceeds durable append cursor");
    outbox.close();
  });

  it("never regresses the durable ACK cursor across overlapping consumers", async () => {
    const path = await temporaryDatabasePath();
    const writer = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await writer.initializeBootstrap(bootstrapInput());
    const firstConsumer = await RunnerSqliteEventOutbox.create(path);
    const staleConsumer = await RunnerSqliteEventOutbox.create(path);
    const first = await writer.append(eventInput("one"));
    const second = await writer.append(eventInput("two"));

    await firstConsumer.acknowledge(bootstrap.stream_id, second.source_seq);
    await staleConsumer.acknowledge(bootstrap.stream_id, first.source_seq);
    expect(staleConsumer.ackedSeq).toBe(second.source_seq);
    expect(await staleConsumer.readBatch()).toBeNull();
    writer.close();
    firstConsumer.close();
    staleConsumer.close();

    const recovered = await RunnerSqliteEventOutbox.create(path);
    expect(recovered.ackedSeq).toBe(second.source_seq);
    expect(await recovered.readBatch()).toBeNull();
    recovered.close();
  });

  it("rejects an event over the Phase 11 2 MiB single-event ceiling", async () => {
    const outbox = await createOutbox();

    await expect(outbox.append(eventInput("x".repeat(EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES))))
      .rejects.toThrow("event payload exceeds 2 MiB ingress single-event contract");
    expect(await outbox.readBatch()).toBeNull();
    outbox.close();
  });

  it("cuts a batch before its serialized frame exceeds 256 KiB", async () => {
    const outbox = await createOutbox();
    const first = await outbox.append({
      ...eventInput("x".repeat(245 * 1024)),
      searchable_text: null,
    });
    await outbox.append({
      ...eventInput("y".repeat(245 * 1024)),
      searchable_text: null,
    });

    const batch = await outbox.readBatch();

    expect(batch?.events).toEqual([first]);
    expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThanOrEqual(256 * 1024);
    outbox.close();
  });

  it("compacts a 1,000-row acknowledged prefix while retaining bootstrap and the tail", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    outbox.close();
    insertFixtureEvents(path, bootstrap.stream_id, EVENT_OUTBOX_COMPACT_ROWS + 1);

    const reopened = await RunnerSqliteEventOutbox.create(path);
    await reopened.acknowledge(bootstrap.stream_id, EVENT_OUTBOX_COMPACT_ROWS + 1);
    const afterCompaction = await reopened.append(eventInput("after compaction"));
    expect(afterCompaction.source_seq).toBe(EVENT_OUTBOX_COMPACT_ROWS + 3);
    reopened.close();

    expect(readStoredSequences(path)).toEqual([
      1,
      EVENT_OUTBOX_COMPACT_ROWS + 2,
      EVENT_OUTBOX_COMPACT_ROWS + 3,
    ]);
  });

  it("reopens when ACK compaction retains only a host-unacknowledged journal event", async () => {
    const path = await temporaryDatabasePath();
    const initial = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await initial.initializeBootstrap(bootstrapInput());
    initial.close();
    insertFixtureEvents(path, bootstrap.stream_id, EVENT_OUTBOX_COMPACT_ROWS);

    const writer = await RunnerSqliteEventOutbox.create(path);
    const retained = await writer.appendEngineFrame(eventInput("host pending"), {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "host pending" },
    });
    await writer.acknowledge(bootstrap.stream_id, retained.source_seq);
    expect(readStoredSequences(path)).toEqual([1, retained.source_seq]);
    writer.close();

    expect(inspectRunnerOutboxCopy(path)).toMatchObject({
      status: "compacted_acknowledged_prefix",
      ackedThrough: retained.source_seq,
      latestSequence: retained.source_seq,
      firstRetainedEventSequence: retained.source_seq,
      retainedEventCount: 1,
      unacknowledgedEventCount: 0,
    });

    const recovered = await RunnerSqliteEventOutbox.create(path);
    await expect(recovered.readBatch()).resolves.toBeNull();
    await expect(recovered.readPendingIpcFrames()).resolves.toMatchObject([{
      outbox_source_seq: retained.source_seq,
    }]);
    recovered.close();
  });

  it("does not burn source_seq when an append transaction rolls back", async () => {
    const path = await temporaryDatabasePath();
    const initial = await RunnerSqliteEventOutbox.create(path);
    await initial.initializeBootstrap(bootstrapInput());
    initial.close();

    const fixture = new DatabaseSync(path);
    fixture.exec(`
      CREATE TRIGGER fail_runner_ipc_journal_insert
      BEFORE INSERT ON runner_ipc_journal
      BEGIN
        SELECT RAISE(ABORT, 'injected journal failure');
      END
    `);
    fixture.close();

    const failing = await RunnerSqliteEventOutbox.create(path);
    await expect(failing.appendEngineFrame(eventInput("rolled back"), {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "rolled back" },
    })).rejects.toThrow("injected journal failure");
    failing.close();

    const cleanup = new DatabaseSync(path);
    cleanup.exec("DROP TRIGGER fail_runner_ipc_journal_insert");
    cleanup.close();

    const recovered = await RunnerSqliteEventOutbox.create(path);
    await expect(recovered.append(eventInput("committed"))).resolves.toMatchObject({
      source_seq: 2,
    });
    recovered.close();
    expect(readStoredSequences(path)).toEqual([1, 2]);
  });

  it("fails closed when the unacknowledged replay suffix has a source_seq gap", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    await outbox.initializeBootstrap(bootstrapInput());
    await outbox.append(eventInput("missing"));
    await outbox.append(eventInput("retained"));
    outbox.close();

    const fixture = new DatabaseSync(path);
    fixture.prepare(
      "DELETE FROM runner_event_outbox WHERE source_seq = ?",
    ).run(2);
    fixture.close();

    expect(inspectRunnerOutboxCopy(path)).toMatchObject({
      status: "quarantine_required",
      ackedThrough: 1,
      latestSequence: 3,
      firstRetainedEventSequence: 3,
      unacknowledgedEventCount: 1,
      error: "event outbox source_seq gap detected: expected 2, found 3, acked_through 1",
    });
    await expect(RunnerSqliteEventOutbox.create(path)).rejects.toThrow(
      "event outbox source_seq gap detected: expected 2, found 3, acked_through 1",
    );
  });

  it("fails closed when acked_through is changed without its checkpoint hash", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    await outbox.initializeBootstrap(bootstrapInput());
    await outbox.append(eventInput("still pending one"));
    await outbox.append(eventInput("still pending two"));
    outbox.close();

    const fixture = new DatabaseSync(path);
    fixture.prepare(`
      UPDATE runner_event_outbox SET acked_through = 3
      WHERE record_kind = 'bootstrap'
    `).run();
    fixture.close();

    expect(inspectRunnerOutboxCopy(path)).toMatchObject({
      status: "quarantine_required",
      ackedThrough: 3,
      latestSequence: 3,
      retainedEventCount: 2,
      unacknowledgedEventCount: 0,
      error: "runner event outbox ACK checkpoint hash mismatch",
    });
    await expect(RunnerSqliteEventOutbox.create(path)).rejects.toThrow(
      "runner event outbox ACK checkpoint hash mismatch",
    );
  });

  it("migrates a legacy v5 ACK cursor once before accepting new writes", async () => {
    const path = await temporaryDatabasePath();
    const initial = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await initial.initializeBootstrap(bootstrapInput());
    const pending = await initial.append(eventInput("pending after migration"));
    initial.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE runner_event_outbox DROP COLUMN ack_checkpoint_hash;
      PRAGMA user_version = 5;
    `);
    legacy.close();

    expect(inspectRunnerOutboxCopy(path)).toMatchObject({
      status: "legacy_unprotected_checkpoint",
      ackedThrough: 1,
      error: "legacy runner outbox requires writable v5-to-v6 ACK checkpoint migration",
    });

    const migrated = await RunnerSqliteEventOutbox.create(path);
    await expect(migrated.readBatch()).resolves.toMatchObject({
      events: [expect.objectContaining({ source_seq: pending.source_seq })],
    });
    migrated.close();

    const verified = new DatabaseSync(path);
    try {
      expect(verified.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
      expect(verified.prepare(`
        SELECT acked_through, ack_checkpoint_hash
        FROM runner_event_outbox WHERE record_kind = 'bootstrap'
      `).get()).toEqual({
        acked_through: 1,
        ack_checkpoint_hash: computeRunnerAckCheckpointHash(
          bootstrap.stream_id,
          bootstrap.session_id,
          1,
        ),
      });
    } finally {
      verified.close();
    }
  });

  it("rolls back an ACK when same-transaction checkpoint verification fails", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    const pending = await outbox.append(eventInput("pending"));
    outbox.close();

    const fixture = new DatabaseSync(path);
    fixture.exec(`
      CREATE TRIGGER corrupt_ack_checkpoint_after_update
      AFTER UPDATE OF acked_through ON runner_event_outbox
      BEGIN
        UPDATE runner_event_outbox SET ack_checkpoint_hash = '${"0".repeat(64)}'
        WHERE record_kind = 'bootstrap';
      END
    `);
    fixture.close();

    const failing = await RunnerSqliteEventOutbox.create(path);
    await expect(failing.acknowledge(bootstrap.stream_id, pending.source_seq)).rejects.toThrow(
      "runner event outbox ACK checkpoint hash mismatch",
    );
    failing.close();

    const unchanged = new DatabaseSync(path);
    try {
      expect(unchanged.prepare(`
        SELECT acked_through, ack_checkpoint_hash
        FROM runner_event_outbox WHERE record_kind = 'bootstrap'
      `).get()).toEqual({
        acked_through: 1,
        ack_checkpoint_hash: computeRunnerAckCheckpointHash(
          bootstrap.stream_id,
          bootstrap.session_id,
          1,
        ),
      });
    } finally {
      unchanged.close();
    }
  });

  it("compacts an acknowledged prefix after its records reach 8 MiB", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await outbox.initializeBootstrap(bootstrapInput());
    outbox.close();
    const eventCount = Math.ceil(EVENT_OUTBOX_COMPACT_BYTES / (245 * 1024)) + 1;
    insertFixtureEvents(path, bootstrap.stream_id, eventCount + 1, 245 * 1024);

    const reopened = await RunnerSqliteEventOutbox.create(path);
    await reopened.acknowledge(bootstrap.stream_id, eventCount + 1);
    reopened.close();

    expect(readStoredSequences(path)).toEqual([1, eventCount + 2]);
  });

  it("detects a durable payload hash mutation during recovery", async () => {
    const path = await temporaryDatabasePath();
    const outbox = await RunnerSqliteEventOutbox.create(path);
    await outbox.initializeBootstrap(bootstrapInput());
    const event = await outbox.append(eventInput("one"));
    outbox.close();

    const database = new DatabaseSync(path);
    database.prepare(
      "UPDATE runner_event_outbox SET payload_json = ? WHERE source_seq = ?",
    ).run(JSON.stringify({ type: "assistant_message", content: "tampered" }), event.source_seq);
    database.close();

    await expect(RunnerSqliteEventOutbox.create(path))
      .rejects.toThrow(`event outbox payload hash mismatch at source_seq ${event.source_seq}`);
  });

  it("feeds the existing pump without repackaging stream_id or source_seq", async () => {
    const outbox = await createOutbox();
    const event = await outbox.append(eventInput("one"));
    const sent: EventOutboxBatch[] = [];
    const pump = new EventOutboxPump(outbox, vi.fn());

    pump.connect(async (batch) => sent.push(batch));
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toMatchObject({
      stream_id: event.stream_id,
      first_seq: event.source_seq,
      events: [{ stream_id: event.stream_id, source_seq: event.source_seq }],
    });
    outbox.close();
  });

  it("drains the next event when another consumer durably ACKs the in-flight batch first", async () => {
    const path = await temporaryDatabasePath();
    const writer = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await writer.initializeBootstrap(bootstrapInput());
    const pumpConsumer = await RunnerSqliteEventOutbox.create(path);
    const competingConsumer = await RunnerSqliteEventOutbox.create(path);
    const sent: EventOutboxBatch[] = [];
    const onError = vi.fn();
    const pump = new EventOutboxPump(pumpConsumer, onError);

    try {
      const first = await writer.append(eventInput("one"));
      pump.connect(async (batch) => sent.push(batch));
      await waitFor(() => sent.length === 1);
      const acknowledged = pump.waitForAcknowledgement(first);

      await competingConsumer.acknowledge(bootstrap.stream_id, first.source_seq);
      await pump.handleAck({
        type: "event_append_ack",
        stream_id: bootstrap.stream_id,
        acked_through: first.source_seq,
        events: [{ source_seq: first.source_seq, event_id: 9102 }],
      });
      await expect(Promise.race([
        acknowledged,
        new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
      ])).resolves.toBe(9102);

      const second = await writer.append(eventInput("two"));
      pump.notifyAvailable();
      await waitFor(() => sent.length === 2);

      expect(sent[1]?.events.map((event) => event.source_seq)).toEqual([second.source_seq]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      writer.close();
      pumpConsumer.close();
      competingConsumer.close();
    }
  });

  it("lets a server-side consumer drain after a content-free cross-process doorbell", async () => {
    const path = await temporaryDatabasePath();
    const consumer = await RunnerSqliteEventOutbox.create(path);
    const sent: EventOutboxBatch[] = [];
    const onError = vi.fn();
    const pump = new EventOutboxPump(consumer, onError);
    pump.connect(async (batch) => sent.push(batch));
    await pump.drainScheduled();

    const writer = await RunnerSqliteEventOutbox.create(path);
    const bootstrap = await writer.initializeBootstrap(bootstrapInput());
    const event = await writer.append(eventInput("one"));
    expect(sent).toEqual([]);
    pump.notifyAvailable();
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toMatchObject({
      stream_id: bootstrap.stream_id,
      first_seq: event.source_seq,
      events: [{ stream_id: bootstrap.stream_id, source_seq: event.source_seq }],
    });
    expect(onError).not.toHaveBeenCalled();
    writer.close();
    consumer.close();
  });

  it("journals only an outbox reference and reconstructs the durable frame from the event ledger", async () => {
    const outbox = await createOutbox();
    const frame = {
      protocolVersion: 1,
      channel: "event" as const,
      kind: "engine_event" as const,
      payload: { type: "assistant_message", content: "one" },
      metadata: { claudeBackgroundProvenance: "sdk_membership" as const },
    };

    const durable = await outbox.appendEngineFrame(eventInput("one"), frame);
    const pending = await outbox.readPendingIpcFrames();

    expect(pending).toEqual([{
      frame_seq: 1,
      outbox_source_seq: durable.source_seq,
      frame,
    }]);
    outbox.close();
  });

  it("compacts journal rows only after both host apply ACK and orch outbox ACK", async () => {
    const outbox = await createOutbox();
    const record = await outbox.appendEngineFrame(eventInput("one"), {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "one" },
    });
    const [entry] = await outbox.readPendingIpcFrames();

    await outbox.acknowledgeHostFrame(entry!.frame_seq);
    expect(await outbox.readPendingIpcFrames()).toEqual([]);
    expect(readJournalSequences(outboxDatabasePath(outbox))).toEqual([entry!.frame_seq]);

    await outbox.acknowledge(record.stream_id, record.source_seq);
    expect(readJournalSequences(outboxDatabasePath(outbox))).toEqual([]);
    outbox.close();
  });

  it("recovers a payload-free host-call apply receipt and compacts it after runner ACK", async () => {
    const path = await temporaryDatabasePath();
    const firstHost = await RunnerSqliteEventOutbox.create(path);
    const secondHost = await RunnerSqliteEventOutbox.create(path);

    await firstHost.recordHostCallApplied({
      correlationId: "host:one",
      service: "snapshot",
      operation: "persistRunState",
      createdAt: "2026-08-11T01:00:00.000Z",
    });

    await expect(secondHost.readHostCallApplied("host:one")).resolves.toEqual({
      correlationId: "host:one",
      service: "snapshot",
      operation: "persistRunState",
    });
    await secondHost.acknowledgeHostCall("host:one");
    await expect(firstHost.readHostCallApplied("host:one")).resolves.toBeNull();
    expect(readJournalSequences(path)).toEqual([]);

    firstHost.close();
    secondHost.close();
  });

  it("compacts orphaned applied host-call receipts only during terminal recovery", async () => {
    const outbox = await createOutbox();
    await outbox.recordHostCallApplied({
      correlationId: "host:orphaned",
      service: "snapshot",
      operation: "persistRunState",
      createdAt: "2026-08-11T01:00:00.000Z",
    });
    expect(await outbox.hasPendingDurableWork()).toBe(true);

    await outbox.compactAppliedHostCallsForTerminalRecovery();

    expect(await outbox.hasPendingDurableWork()).toBe(false);
    await expect(outbox.readHostCallApplied("host:orphaned")).resolves.toBeNull();
    outbox.close();
  });

  it("migrates the payload-free v3 event journal without losing pending frame order", async () => {
    const path = await temporaryDatabasePath();
    const current = await RunnerSqliteEventOutbox.create(path);
    await current.initializeBootstrap(bootstrapInput());
    await current.appendEngineFrame(eventInput("one"), {
      protocolVersion: 1,
      channel: "event",
      kind: "engine_event",
      payload: { type: "assistant_message", content: "one" },
    });
    current.close();

    const database = new DatabaseSync(path);
    database.exec(`
      ALTER TABLE runner_ipc_journal RENAME TO runner_ipc_journal_v4;
      CREATE TABLE runner_ipc_journal (
        frame_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        outbox_source_seq INTEGER NOT NULL UNIQUE,
        frame_kind TEXT NOT NULL CHECK (frame_kind = 'engine_event'),
        host_acked INTEGER NOT NULL DEFAULT 0 CHECK (host_acked IN (0, 1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (outbox_source_seq) REFERENCES runner_event_outbox(source_seq)
      ) STRICT;
      INSERT INTO runner_ipc_journal
      SELECT frame_seq, outbox_source_seq, frame_kind, host_acked, created_at
      FROM runner_ipc_journal_v4;
      DROP TABLE runner_ipc_journal_v4;
      PRAGMA user_version = 3;
    `);
    database.close();

    const migrated = await RunnerSqliteEventOutbox.create(path);
    await expect(migrated.readPendingIpcFrames()).resolves.toEqual([
      expect.objectContaining({ frame_seq: 1, outbox_source_seq: 2 }),
    ]);
    await migrated.recordHostCallApplied({
      correlationId: "host:migrated",
      service: "snapshot",
      operation: "persistSessionItems",
      createdAt: "2026-08-11T01:00:00.000Z",
    });
    await expect(migrated.readHostCallApplied("host:migrated")).resolves.toMatchObject({
      operation: "persistSessionItems",
    });
    migrated.close();
  });
});

async function createOutbox(): Promise<RunnerSqliteEventOutbox> {
  const path = await temporaryDatabasePath();
  const outbox = await RunnerSqliteEventOutbox.create(path);
  await outbox.initializeBootstrap(bootstrapInput());
  return outbox;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-outbox-"));
  tempDirectories.push(directory);
  return join(directory, "outbox.sqlite");
}

function bootstrapInput(): RunnerBootstrapInput {
  return {
    session_id: "session-a",
    created_at: "2026-08-11T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-session-a",
      cwd: "/workspace/session-a",
      codex_home: "/workspace/session-a/.codex",
      rollout_root: "/workspace/session-a/.codex/sessions",
      code_sha: "f169f3bb",
      snapshot_path: "/releases/f169f3bb/soul-server-ts",
    },
  };
}

function eventInput(content: string): EventOutboxAppendInput {
  return {
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content },
    searchable_text: content,
    created_at: "2026-08-11T00:00:01.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
}

function unsigned(record: Awaited<ReturnType<RunnerSqliteEventOutbox["initializeBootstrap"]>>) {
  const { payload_hash: _payloadHash, ...value } = record;
  return value;
}

function insertFixtureEvents(
  path: string,
  streamId: string,
  count: number,
  contentBytes = 0,
): void {
  const database = new DatabaseSync(path);
  const insert = database.prepare(`
    INSERT INTO runner_event_outbox (
      source_seq, record_kind, stream_id, session_id, event_type,
      payload_json, searchable_text, created_at, semantic_dedupe_key,
      session_effect_json, payload_hash, acked_through
    ) VALUES (?, 'event', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index += 1) {
      const sourceSeq = index + 2;
      const input = {
        ...eventInput(contentBytes > 0 ? "x".repeat(contentBytes) : String(sourceSeq)),
        searchable_text: contentBytes > 0 ? null : String(sourceSeq),
      };
      const value = { stream_id: streamId, source_seq: sourceSeq, ...input };
      insert.run(
        sourceSeq,
        streamId,
        input.session_id,
        input.event_type,
        JSON.stringify(input.payload),
        input.searchable_text,
        input.created_at,
        input.semantic_dedupe_key,
        computeEventOutboxPayloadHash(value),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function readStoredSequences(path: string): number[] {
  const database = new DatabaseSync(path);
  try {
    return (database.prepare(
      "SELECT source_seq FROM runner_event_outbox ORDER BY source_seq",
    ).all() as Array<{ source_seq: number }>).map((row) => row.source_seq);
  } finally {
    database.close();
  }
}

function readJournalSequences(path: string): number[] {
  const database = new DatabaseSync(path);
  try {
    return (database.prepare(
      "SELECT frame_seq FROM runner_ipc_journal ORDER BY frame_seq",
    ).all() as Array<{ frame_seq: number }>).map((row) => row.frame_seq);
  } finally {
    database.close();
  }
}

function outboxDatabasePath(outbox: RunnerSqliteEventOutbox): string {
  return outbox.databasePath;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
