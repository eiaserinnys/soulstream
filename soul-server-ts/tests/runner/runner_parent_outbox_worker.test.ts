import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerPhaseObservation,
} from "../../src/runner/runner_phase_observation.js";
import {
  RunnerParentOutbox,
  type RunnerParentOutboxOptions,
} from "../../src/runner/runner_parent_outbox.js";
import {
  readRunnerHostAcknowledgedThrough,
  RunnerHostStateStore,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
import { writeRunnerRegistrationIdentity } from
  "../../src/runner/runner_registration_identity.js";
import type { RunnerSqliteTransactionEvent } from
  "../../src/runner/runner_sqlite_connection.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapInput,
  type RunnerBootstrapRecord,
} from "../../src/runner/sqlite_event_outbox.js";
import type {
  EventOutboxAppendInput,
  EventOutboxRecord,
} from "../../src/upstream/event_outbox.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

type FixtureMode = "real" | "gate" | "hang" | "close_without_response";

const tempDirectories: string[] = [];
const openOutboxes: RunnerParentOutbox[] = [];

afterEach(async () => {
  await Promise.allSettled(openOutboxes.splice(0).map(
    async (outbox) => await outbox.close(),
  ));
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerParentOutbox worker boundary", () => {
  it("opens and closes a normal parent outbox through a real worker", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    const outbox = await openOutbox(databasePath);

    expect(outbox.streamId).toBe(bootstrap!.stream_id);
    expect(outbox.ackedSeq).toBe(1);
    await expect(outbox.readBatch()).resolves.toMatchObject({
      stream_id: bootstrap!.stream_id,
      events: [expect.objectContaining({ source_seq: events[0]!.source_seq })],
    });

    await outbox.close();
    await expect(outbox.readBatch()).rejects.toThrow(/closing|closed/);
  });

  it("opens and closes the closed-tail parent outbox through a real worker", async () => {
    const { databasePath, directory, bootstrap } = await createRunnerDatabase({
      events: ["tail"],
    });
    await writeRunnerRegistrationIdentity(directory, {
      schemaVersion: 1,
      registrationId: "registration-a",
      sessionId: "session-a",
      codeSha: "sha-a",
      pid: process.pid,
      startIdentity: "start-a",
    });

    const outbox = await RunnerParentOutbox.openClosedTail(databasePath, "session-a");
    openOutboxes.push(outbox);

    await expect(outbox.readBootstrap()).resolves.toMatchObject({
      stream_id: bootstrap!.stream_id,
    });
    await outbox.close();
  });

  it("opens before bootstrap and adopts the bootstrap created later", async () => {
    const { databasePath } = await createRunnerDatabase({ bootstrap: false });
    const outbox = await openOutbox(databasePath);

    await expect(outbox.readBootstrap()).resolves.toBeNull();
    expect(outbox.ackedSeq).toBe(0);
    expect(() => outbox.streamId).toThrow(
      "runner bootstrap record required before event append",
    );
    await expect(outbox.readBatch()).resolves.toBeNull();
    await expect(outbox.readLatestPendingRecord()).resolves.toBeNull();
    await expect(outbox.hasPendingDurableWork()).resolves.toBe(false);

    const writer = await RunnerSqliteEventOutbox.create(databasePath);
    let bootstrap: RunnerBootstrapRecord;
    try {
      bootstrap = await writer.initializeBootstrap(bootstrapInput());
    } finally {
      writer.close();
    }

    await expect(outbox.readBootstrap()).resolves.toMatchObject({
      stream_id: bootstrap.stream_id,
    });
    expect(outbox.streamId).toBe(bootstrap.stream_id);
    expect(outbox.ackedSeq).toBe(1);
    await outbox.close();
  });

  it("advances the ACK cache only after the worker reports the host commit", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one", "two"],
    });
    const onCheckpointAdvanced = vi.fn(async () => {});
    const outbox = await openOutbox(databasePath, "session-a", {
      onCheckpointAdvanced,
    });

    expect(outbox.ackedSeq).toBe(1);
    await outbox.acknowledge(bootstrap!.stream_id, events[0]!.source_seq);

    expect(outbox.ackedSeq).toBe(events[0]!.source_seq);
    expect(onCheckpointAdvanced).toHaveBeenCalledWith(events[0]!.source_seq);
    await expect(hostAck(databasePath, bootstrap!.stream_id)).resolves.toBe(
      events[0]!.source_seq,
    );

    await outbox.acknowledge(bootstrap!.stream_id, 1);
    expect(outbox.ackedSeq).toBe(events[0]!.source_seq);
    await outbox.close();
  });

  it("preserves SQLITE_BUSY details and keeps the parent heartbeat while the worker waits on a host write lock", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "parent-outbox-ack-failure",
      operation: "runner.parent",
      logger: { warn: vi.fn() },
    });
    const transactionEvents: RunnerSqliteTransactionEvent[] = [];
    const onCheckpointAdvanced = vi.fn(async () => {});
    const outbox = await openOutbox(databasePath, "session-a", {
      onCheckpointAdvanced,
      phaseObservation: observation,
      transactionObserver: (event) => transactionEvents.push(event),
    });
    const lock = new DatabaseSync(runnerHostStatePath(databasePath));
    lock.exec("BEGIN IMMEDIATE");
    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
    }, 5);
    try {
      const error = await outbox
        .acknowledge(bootstrap!.stream_id, events[0]!.source_seq)
        .catch((value) => value);

      expect(error).toBeInstanceOf(Error);
      expect((error as { errcode?: unknown }).errcode).toBeTypeOf("number");
      expect(((error as { errcode: number }).errcode & 0xff)).toBe(5);
      expect((error as { code?: unknown }).code).not.toBe("WORKER_ERROR");
      expect(outbox.ackedSeq).toBe(1);
      expect(onCheckpointAdvanced).not.toHaveBeenCalled();
      expect(beats).toBeGreaterThan(0);
      expect(observation.failureFor(error)?.phase).toBe("dbWorkerWait");
      expect(transactionEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          transactionLabel: "runner_host.acknowledge_event",
          stage: "failed",
          errorCode: expect.any(String),
        }),
      ]));
    } finally {
      clearInterval(timer);
      lock.exec("ROLLBACK");
      lock.close();
    }

    await outbox.acknowledge(bootstrap!.stream_id, events[0]!.source_seq);
    expect(outbox.ackedSeq).toBe(events[0]!.source_seq);
    await outbox.close();
  });

  it("applies the ACK cache before awaiting the checkpoint callback", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    let insideCache: number | null = null;
    let insideHostCommit: number | null = null;
    let outbox!: RunnerParentOutbox;
    outbox = await openOutbox(databasePath, "session-a", {
      onCheckpointAdvanced: async (acknowledgedThrough) => {
        expect(acknowledgedThrough).toBe(events[0]!.source_seq);
        insideCache = outbox.ackedSeq;
        insideHostCommit = await hostAck(databasePath, bootstrap!.stream_id);
      },
    });

    await outbox.acknowledge(bootstrap!.stream_id, events[0]!.source_seq);

    expect(insideCache).toBe(events[0]!.source_seq);
    expect(insideHostCommit).toBe(events[0]!.source_seq);
    await outbox.close();
  });

  it("rejects acknowledge when the checkpoint callback fails but keeps the committed cache", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    const outbox = await openOutbox(databasePath, "session-a", {
      onCheckpointAdvanced: async () => {
        throw new Error("checkpoint callback failed");
      },
    });

    await expect(
      outbox.acknowledge(bootstrap!.stream_id, events[0]!.source_seq),
    ).rejects.toThrow("checkpoint callback failed");

    expect(outbox.ackedSeq).toBe(events[0]!.source_seq);
    await expect(hostAck(databasePath, bootstrap!.stream_id)).resolves.toBe(
      events[0]!.source_seq,
    );
    await outbox.close();
  });

  it("returns the same batch, record, IPC frames, and pending record as the durable store", async () => {
    const { databasePath, events, ipcRecord } = await createRunnerDatabase({
      events: ["one", "two"],
      ipcFrame: "frame",
    });
    const outbox = await openOutbox(databasePath);
    const reader = await RunnerSqliteEventOutbox.openReadOnly(databasePath, {
      sessionId: "session-a",
    });
    try {
      await expect(outbox.readBatch()).resolves.toEqual(
        await reader.readBatchAfter(1),
      );
      await expect(outbox.readRecord(events[0]!.source_seq)).resolves.toEqual(
        await reader.readRecord(events[0]!.source_seq),
      );
      await expect(outbox.readPendingIpcFrames()).resolves.toEqual(
        await reader.readPendingIpcFrames(),
      );
      await expect(outbox.readLatestPendingRecord()).resolves.toEqual(
        await reader.readLatestPendingRecordAfter(1),
      );
    } finally {
      reader.close();
    }
    expect(ipcRecord).not.toBeNull();
    await outbox.close();
  });

  it("records, reads, and acknowledges host call receipts through the worker", async () => {
    const { databasePath } = await createRunnerDatabase({});
    const outbox = await openOutbox(databasePath);
    const input = {
      correlationId: "host:1",
      service: "task",
      operation: "stop",
      createdAt: "2026-11-11T00:00:04.000Z",
    };

    await outbox.recordHostCallApplied(input);
    await expect(outbox.readHostCallApplied(input.correlationId)).resolves
      .toMatchObject({ service: "task", operation: "stop" });

    const verifier = RunnerHostStateStore.open(
      runnerHostStatePath(databasePath),
      undefined,
      { sessionId: "session-a" },
    );
    try {
      expect(verifier.readHostCallApplied("session-a", input.correlationId))
        .toMatchObject({ service: "task", operation: "stop" });
    } finally {
      verifier.close();
    }

    await outbox.acknowledgeHostCall(input.correlationId);
    await expect(outbox.readHostCallApplied(input.correlationId)).resolves
      .toBeNull();
    await outbox.close();
  });

  it("appends a quarantine file and commits the ACK through the worker", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    const onCheckpointAdvanced = vi.fn(async () => {});
    const outbox = await openOutbox(databasePath, "session-a", {
      onCheckpointAdvanced,
    });
    const record = await outbox.readRecord(events[0]!.source_seq);
    expect(record).not.toBeNull();

    const result = await outbox.quarantineHead({
      record: record!,
      rejection: { code: "TEST_REJECTION", reason: "test rejection" },
      attempts: 1,
      quarantinedAt: "2026-11-11T00:00:00.000Z",
    });

    expect(result.sourceSeq).toBe(events[0]!.source_seq);
    const lines = (await readFile(result.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: { source_seq: events[0]!.source_seq },
    });
    expect(outbox.ackedSeq).toBe(events[0]!.source_seq);
    expect(onCheckpointAdvanced).toHaveBeenCalledWith(events[0]!.source_seq);
    await expect(hostAck(databasePath, bootstrap!.stream_id)).resolves.toBe(
      events[0]!.source_seq,
    );
    await outbox.close();
  });

  it("does not ACK when the quarantine file cannot be written", async () => {
    const { databasePath, directory, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    await mkdir(join(directory, "quarantine-20261111-sess.jsonl"));
    const onCheckpointAdvanced = vi.fn(async () => {});
    const outbox = await openOutbox(databasePath, "session-a", {
      onCheckpointAdvanced,
    });
    const record = await outbox.readRecord(events[0]!.source_seq);

    await expect(outbox.quarantineHead({
      record: record!,
      rejection: { code: "TEST_REJECTION", reason: "test rejection" },
      attempts: 1,
      quarantinedAt: "2026-11-11T00:00:00.000Z",
    })).rejects.toThrow();

    expect(outbox.ackedSeq).toBe(1);
    expect(onCheckpointAdvanced).not.toHaveBeenCalled();
    await expect(hostAck(databasePath, bootstrap!.stream_id)).resolves.toBe(1);
    await outbox.close();
  });

  it("serializes a delayed quarantine ahead of later ACK and close requests", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one", "two"],
    });
    const signal = new SharedArrayBuffer(4);
    const release = new SharedArrayBuffer(4);
    const outbox = await openOutbox(databasePath, "session-a", {
      workerFactory: fixtureWorkerFactory("gate", { signal, release }),
    });
    const record = await outbox.readRecord(events[0]!.source_seq);
    const order: string[] = [];
    let released = false;

    try {
      const quarantine = outbox.quarantineHead({
        record: record!,
        rejection: { code: "TEST_REJECTION", reason: "test rejection" },
        attempts: 1,
        quarantinedAt: "2026-11-11T00:00:00.000Z",
      }).then((value) => {
        order.push("quarantine");
        return value;
      });
      await waitForAtomics(signal, 1, 2_000);

      const acknowledge = outbox
        .acknowledge(bootstrap!.stream_id, events[1]!.source_seq)
        .then(() => {
          order.push("ack");
        });
      const close = outbox.close().then(() => {
        order.push("close");
      });
      await expect(outbox.readBatch()).rejects.toThrow(/closing|closed/);
      await sleep(50);
      expect(order).toEqual([]);

      released = true;
      Atomics.store(new Int32Array(release), 0, 1);
      Atomics.notify(new Int32Array(release), 0);

      await quarantine;
      await acknowledge;
      await close;
      expect(order).toEqual(["quarantine", "ack", "close"]);
      expect(outbox.ackedSeq).toBe(events[1]!.source_seq);
      await expect(hostAck(databasePath, bootstrap!.stream_id)).resolves.toBe(
        events[1]!.source_seq,
      );
    } finally {
      if (!released) {
        Atomics.store(new Int32Array(release), 0, 1);
        Atomics.notify(new Int32Array(release), 0);
      }
    }
  });

  it("keeps the parent heartbeat running while the worker is blocked at the commit observation", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    const signal = new SharedArrayBuffer(4);
    const release = new SharedArrayBuffer(4);
    const outbox = await openOutbox(databasePath, "session-a", {
      workerFactory: fixtureWorkerFactory("gate", { signal, release }),
    });
    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
    }, 10);
    let released = false;
    try {
      const acknowledge = outbox.acknowledge(
        bootstrap!.stream_id,
        events[0]!.source_seq,
      );
      acknowledge.catch(() => {});
      await waitForAtomics(signal, 1, 2_000);
      await sleep(100);
      expect(beats).toBeGreaterThanOrEqual(2);

      released = true;
      Atomics.store(new Int32Array(release), 0, 1);
      Atomics.notify(new Int32Array(release), 0);

      await acknowledge;
      expect(outbox.ackedSeq).toBe(events[0]!.source_seq);
      await expect(hostAck(databasePath, bootstrap!.stream_id)).resolves.toBe(
        events[0]!.source_seq,
      );
    } finally {
      clearInterval(timer);
      if (!released) {
        Atomics.store(new Int32Array(release), 0, 1);
        Atomics.notify(new Int32Array(release), 0);
      }
    }
  });

  it("rejects pending and later requests when the worker thread dies", async () => {
    const { databasePath } = await createRunnerDatabase({ events: ["one"] });
    let worker: Worker | undefined;
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "parent-outbox-worker-crash",
      operation: "runner.parent",
      logger: { warn: vi.fn() },
    });
    const outbox = await openOutbox(databasePath, "session-a", {
      phaseObservation: observation,
      workerFactory: fixtureWorkerFactory("hang", {}, (created) => {
        worker = created;
      }),
    });

    const pending = outbox.readBatch();
    pending.catch(() => {});
    await sleep(50);
    await worker!.terminate();
    const error = await pending.catch((value) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/worker/);
    await expect(outbox.readBatch()).rejects.toBe(error);
    await expect(outbox.close()).rejects.toBe(error);
    expect(observation.failureFor(error)?.phase).toBe("dbWorkerWait");
  });

  it("returns the same close promise and rejects regular requests once closing starts", async () => {
    const { databasePath } = await createRunnerDatabase({ events: ["one"] });
    const outbox = await openOutbox(databasePath);

    const first = outbox.close();
    const second = outbox.close();
    expect(second).toBe(first);
    await first;
    await expect(outbox.readBatch()).rejects.toThrow(/closing|closed/);
  });

  it("fails close when the worker exits without a close response even with exit code zero", async () => {
    const { databasePath } = await createRunnerDatabase({ events: ["one"] });
    const outbox = await openOutbox(databasePath, "session-a", {
      workerFactory: fixtureWorkerFactory("close_without_response"),
    });

    await expect(outbox.close()).rejects.toThrow(/exited before completing/);
  });

  it("forwards worker phases, transaction stages, and SQLite error details to the parent observer", async () => {
    const { databasePath, bootstrap, events } = await createRunnerDatabase({
      events: ["one"],
    });
    const transactionEvents: RunnerSqliteTransactionEvent[] = [];
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "parent-outbox-observation",
      operation: "runner.parent",
      logger: { warn: vi.fn() },
    });
    const outbox = await openOutbox(databasePath, "session-a", {
      phaseObservation: observation,
      transactionObserver: (event) => transactionEvents.push(event),
    });

    await outbox.readBootstrap();
    await outbox.acknowledge(bootstrap!.stream_id, events[0]!.source_seq);
    await outbox.close();

    const summary = observation.databaseSummary();
    expect(summary?.counts.dbOpen).toBeGreaterThanOrEqual(2);
    expect(summary?.counts.dbRead).toBeGreaterThanOrEqual(1);
    expect(summary?.counts.dbClose).toBeGreaterThanOrEqual(1);
    expect(observation.phaseDurationsMs()).toHaveProperty("dbWorkerWait");
    expect(transactionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transactionLabel: "runner_host.initialize_checkpoint",
        stage: "begin",
      }),
      expect.objectContaining({
        transactionLabel: "runner_host.acknowledge_event",
        stage: "commit",
      }),
      expect.objectContaining({
        transactionLabel: "runner_host.acknowledge_event",
        stage: "completed",
      }),
    ]));
    for (const event of transactionEvents) {
      const [prefix, pid, sequence] = event.transactionId.split(":");
      expect(prefix).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number(pid)).toBeGreaterThan(0);
      expect(Number(sequence)).toBeGreaterThan(0);
    }
  });
});

async function openOutbox(
  databasePath: string,
  sessionId = "session-a",
  options: RunnerParentOutboxOptions = {},
): Promise<RunnerParentOutbox> {
  const outbox = await RunnerParentOutbox.open(databasePath, sessionId, options);
  openOutboxes.push(outbox);
  return outbox;
}

function fixtureWorkerFactory(
  mode: FixtureMode,
  extras: { signal?: SharedArrayBuffer; release?: SharedArrayBuffer } = {},
  onWorker?: (worker: Worker) => void,
): (workerData: Record<string, unknown>) => Worker {
  const entryUrl = new URL(
    "./fixtures/runner_parent_storage_test_worker.ts",
    import.meta.url,
  ).href;
  return (workerData) => {
    const worker = new Worker(`
      const { pathToFileURL } = require("node:url");
      import("tsx/esm/api").then(({ tsImport }) =>
        tsImport(${JSON.stringify(entryUrl)}, pathToFileURL(process.cwd() + "/").href)
      ).catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `, { eval: true, workerData: { ...workerData, mode, ...extras } });
    onWorker?.(worker);
    return worker;
  };
}

async function waitForAtomics(
  buffer: SharedArrayBuffer,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const view = new Int32Array(buffer);
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(view, 0) !== expected) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the worker gate");
    }
    await sleep(5);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface RunnerDatabaseFixture {
  directory: string;
  databasePath: string;
  bootstrap: RunnerBootstrapRecord | null;
  events: EventOutboxRecord[];
  ipcRecord: EventOutboxRecord | null;
}

async function createRunnerDatabase(options: {
  events?: string[];
  bootstrap?: boolean;
  ipcFrame?: string;
} = {}): Promise<RunnerDatabaseFixture> {
  const directory = await mkdtemp(join(tmpdir(), "parent-outbox-worker-"));
  tempDirectories.push(directory);
  const databasePath = join(directory, "runner.sqlite");
  const writer = await RunnerSqliteEventOutbox.create(databasePath);
  try {
    if (options.bootstrap === false) {
      return {
        directory,
        databasePath,
        bootstrap: null,
        events: [],
        ipcRecord: null,
      };
    }
    const bootstrap = await writer.initializeBootstrap(bootstrapInput());
    const events: EventOutboxRecord[] = [];
    for (const content of options.events ?? []) {
      events.push(await writer.append(eventInput(content)));
    }
    let ipcRecord: EventOutboxRecord | null = null;
    if (options.ipcFrame !== undefined) {
      ipcRecord = await writer.appendEngineFrame(eventInput(options.ipcFrame), {
        protocolVersion: 1,
        channel: "event",
        kind: "engine_event",
        payload: { type: "assistant_message", content: options.ipcFrame },
      });
    }
    return { directory, databasePath, bootstrap, events, ipcRecord };
  } finally {
    writer.close();
  }
}

async function hostAck(
  databasePath: string,
  streamId: string,
): Promise<number | null> {
  return await readRunnerHostAcknowledgedThrough(
    runnerHostStatePath(databasePath),
    streamId,
    "session-a",
  );
}

function bootstrapInput(): RunnerBootstrapInput {
  return {
    session_id: "session-a",
    created_at: "2026-11-11T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-session-a",
      cwd: "/workspace/session-a",
      codex_home: "/workspace/session-a/.codex",
      rollout_root: "/workspace/session-a/.codex/sessions",
      code_sha: "sha-a",
      snapshot_path: "/releases/sha-a/soul-server-ts",
    },
  };
}

function eventInput(content: string): EventOutboxAppendInput {
  return {
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content },
    searchable_text: content,
    created_at: "2026-11-11T00:00:01.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
}
