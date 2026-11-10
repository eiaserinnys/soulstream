import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readClosedRunnerTailStateLocal } from
  "../../src/runner/closed_runner_tail_state.js";
import { RunnerClaudeAccountTurnStateStore } from
  "../../src/runner/claude_account_turn_state_store.js";
import { readAuthoritativeRunnerLifecycleLocal } from
  "../../src/runner/runner_lifecycle_reader.js";
import { createRunnerPhaseObservation } from
  "../../src/runner/runner_phase_observation.js";
import { RunnerParentOutbox } from "../../src/runner/runner_parent_outbox.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  probeRunnerDurableRetention,
  scanRunnerRegistrations,
  type RunnerRegistration,
} from "../../src/runner/runner_process_registry.js";
import {
  RunnerHostStateStore,
  runnerHostStatePath,
} from "../../src/runner/runner_host_state_store.js";
import {
  pendingRunnerRegistrationIdentity,
  recoverRunnerDirectoryIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerRegistrationScanCache } from
  "../../src/runner/runner_registration_scan_cache.js";
import {
  RunnerRecoveryStorage,
  withRunnerRecoveryStorage,
} from "../../src/runner/runner_recovery_storage.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import {
  runnerLifecycleSummaryPath,
  readRunnerSqliteLifecycle,
  RunnerSqliteLifecycle,
} from "../../src/runner/sqlite_runner_lifecycle.js";
import type { EventOutboxAppendInput } from "../../src/upstream/event_outbox.js";

type FixtureMode = "real" | "gate" | "hang" | "close_without_response" | "notice";

const tempDirectories: string[] = [];
const storages: RunnerRecoveryStorage[] = [];
const outboxes: RunnerParentOutbox[] = [];

afterEach(async () => {
  await Promise.allSettled(outboxes.splice(0).map(async (outbox) => await outbox.close()));
  await Promise.allSettled(storages.splice(0).map(async (storage) => await storage.close()));
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner recovery storage worker boundary", () => {
  it("reads lifecycle and closed tail through the scan path with one shared worker", async () => {
    const stateDirectory = await temporaryDirectory("scan");
    const open = await createRegistration(stateDirectory, "session-open", {
      lifecycleState: "running",
    });
    const closed = await createRegistration(stateDirectory, "session-closed", {
      lifecycleState: "closed",
      acknowledgeHead: true,
    });
    const factory = countingFactory("real");
    const storage = openStorage(factory.workerFactory);

    await scanRunnerRegistrations(stateDirectory, {
      recoveryStorage: storage,
      verifyProcessIdentity: false,
      cache: new RunnerRegistrationScanCache(),
    });
    const first = await scanRunnerRegistrations(stateDirectory, {
      recoveryStorage: storage,
      verifyProcessIdentity: false,
      cache: new RunnerRegistrationScanCache(),
    });
    expect(first.errors).toEqual([]);
    expect(first.registrations).toHaveLength(2);
    const bySession = new Map(first.registrations.map((registration) => [
      registration.config.sessionId,
      registration,
    ]));
    expect(bySession.get("session-open")).toMatchObject({
      pid: process.pid,
      pidAlive: true,
      lifecycle: {
        execution_command_id: open.commandId,
        execution_state: "running",
      },
    });
    expect(bySession.get("session-closed")).toMatchObject({
      pid: process.pid,
      pidAlive: true,
      lifecycle: {
        execution_command_id: closed.commandId,
        execution_state: "closed",
      },
      closedTailState: {
        status: "fully_acknowledged",
        latestDurableSourceSeq: 2,
        acknowledgedThrough: 2,
      },
    });

    const second = await scanRunnerRegistrations(stateDirectory, {
      recoveryStorage: storage,
      verifyProcessIdentity: false,
      cache: new RunnerRegistrationScanCache(),
    });
    expect(second.registrations).toEqual(first.registrations);
    expect(factory.created).toBe(1);
  });

  it.each(["missing", "corrupt", "stale"] as const)(
    "repairs a %s lifecycle sidecar from SQLite without changing the database",
    async (cacheState) => {
      const fixture = await createDatabase({ events: ["one"] });
      const lifecycle = RunnerSqliteLifecycle.open(fixture.databasePath);
      lifecycle.begin({
        pid: process.pid,
        commandId: `execute-${cacheState}`,
        progressedAt: "2026-11-11T00:00:01.000Z",
      });
      lifecycle.close();
      const summaryPath = runnerLifecycleSummaryPath(fixture.databasePath);
      if (cacheState === "missing") {
        await rm(summaryPath, { force: true });
      } else if (cacheState === "corrupt") {
        await writeFile(summaryPath, "{invalid");
      } else {
        await writeFile(summaryPath, JSON.stringify({
          ...readRunnerSqliteLifecycle(fixture.databasePath)!,
          runner_pid: process.pid + 1000,
          execution_state: "closed",
        }));
      }
      const before = await stat(fixture.databasePath, { bigint: true });
      const storage = openStorage(countingFactory("real").workerFactory);

      const record = await storage.readAuthoritativeLifecycle({
        databasePath: fixture.databasePath,
        sessionId: "session-a",
      });

      expect(record).toMatchObject({
        runner_pid: process.pid,
        execution_command_id: `execute-${cacheState}`,
        execution_state: "running",
      });
      expect(JSON.parse(await readFile(summaryPath, "utf8"))).toMatchObject({
        runner_pid: process.pid,
        execution_command_id: `execute-${cacheState}`,
        execution_state: "running",
      });
      const after = await stat(fixture.databasePath, { bigint: true });
      expect({ ino: after.ino, mtimeNs: after.mtimeNs })
        .toEqual({ ino: before.ino, mtimeNs: before.mtimeNs });
    },
  );

  it("does not rewrite a current lifecycle sidecar", async () => {
    const fixture = await createDatabase({ events: ["one"] });
    const lifecycle = RunnerSqliteLifecycle.open(fixture.databasePath);
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-current",
      progressedAt: "2026-11-11T00:00:01.000Z",
    });
    lifecycle.close();
    const storage = openStorage(countingFactory("real").workerFactory);
    await storage.readAuthoritativeLifecycle({
      databasePath: fixture.databasePath,
      sessionId: "session-a",
    });
    const summaryPath = runnerLifecycleSummaryPath(fixture.databasePath);
    const before = await stat(summaryPath, { bigint: true });

    await storage.readAuthoritativeLifecycle({
      databasePath: fixture.databasePath,
      sessionId: "session-a",
    });

    const after = await stat(summaryPath, { bigint: true });
    expect({ ino: after.ino, mtimeNs: after.mtimeNs })
      .toEqual({ ino: before.ino, mtimeNs: before.mtimeNs });
  });

  it("returns the same four closed tail classifications as the worker-only body", async () => {
    const empty = await createDatabase({ bootstrap: false });
    const acknowledged = await createDatabase({ events: ["one"] });
    acknowledgeThroughHead(acknowledged.databasePath, acknowledged.streamId!, "session-a", 2);
    const drain = await createDatabase({ events: ["one"] });
    acknowledgeThroughHead(drain.databasePath, drain.streamId!, "session-a", 1);
    const mismatch = await createDatabase({ events: ["one"] });
    const storage = openStorage(countingFactory("real").workerFactory);

    const cases = [
      { fixture: empty, sessionId: "session-a" },
      { fixture: acknowledged, sessionId: "session-a" },
      { fixture: drain, sessionId: "session-a" },
      { fixture: mismatch, sessionId: "session-b" },
    ] as const;
    const expectedStatuses = [
      "empty_prebootstrap",
      "fully_acknowledged",
      "requires_drain",
      "unknown",
    ];
    for (const [index, current] of cases.entries()) {
      const viaWorker = await storage.readClosedTail({
        databasePath: current.fixture.databasePath,
        sessionId: current.sessionId,
      });
      const local = readClosedRunnerTailStateLocal(
        current.fixture.databasePath,
        current.sessionId,
      );
      expect(viaWorker).toEqual(local);
      expect(viaWorker.status).toBe(expectedStatuses[index]);
    }
  });

  it("returns the same retention decisions as the worker-only body", async () => {
    const storage = openStorage(countingFactory("real").workerFactory);
    const cases: Array<{
      label: string;
      databasePath: string;
      sessionId: string;
      closedTailState?: RunnerRegistration["closedTailState"];
      expected: string | null;
    }> = [];

    const ackDelay = await createDatabase({ events: ["one"] });
    beginLifecycle(ackDelay.databasePath, "execute-ack-delay");
    cases.push({
      label: "ack delay",
      databasePath: ackDelay.databasePath,
      sessionId: "session-a",
      expected: "final_ack_pending",
    });

    const pendingFrame = await createDatabase({ events: ["one"], engineFrames: 1 });
    beginLifecycle(pendingFrame.databasePath, "execute-pending-frame");
    acknowledgeThroughHead(pendingFrame.databasePath, pendingFrame.streamId!, "session-a", 3);
    cases.push({
      label: "pending frame",
      databasePath: pendingFrame.databasePath,
      sessionId: "session-a",
      expected: "durable_replay_pending",
    });

    const pendingIntervention = await createDatabase({
      events: ["one"],
      interventions: ["intervention-a"],
    });
    beginLifecycle(pendingIntervention.databasePath, "execute-pending-intervention");
    acknowledgeThroughHead(
      pendingIntervention.databasePath,
      pendingIntervention.streamId!,
      "session-a",
      2,
    );
    cases.push({
      label: "pending intervention",
      databasePath: pendingIntervention.databasePath,
      sessionId: "session-a",
      expected: "durable_replay_pending",
    });

    cases.push({
      label: "closed tail fast path",
      databasePath: join(await temporaryDirectory("no-db"), "runner.sqlite"),
      sessionId: "session-a",
      closedTailState: {
        status: "requires_drain",
        streamId: "stream-a",
        sessionId: "session-a",
        latestDurableSourceSeq: 2,
        acknowledgedThrough: 1,
      },
      expected: "final_ack_pending",
    });
    cases.push({
      label: "full inspector fallback",
      databasePath: join(await temporaryDirectory("unknown-tail"), "runner.sqlite"),
      sessionId: "session-a",
      closedTailState: { status: "unknown", reason: "damaged" },
      expected: null,
    });

    for (const current of cases) {
      const registration = registrationFor(
        current.databasePath,
        current.sessionId,
        current.closedTailState,
      );
      const viaWorker = await storage.probeDurableRetention(registration);
      const local = await probeRunnerDurableRetention(registration);
      expect(viaWorker, current.label).toEqual(local);
      expect(viaWorker.localRetentionReason, current.label).toBe(current.expected);
    }
  });

  it("reads identity from the sidecar without opening SQLite and falls back when it is damaged", async () => {
    const directory = await temporaryDirectory("identity");
    const database = await createDatabase({ directory, events: ["one"] });
    const sidecar = pendingRunnerRegistrationIdentity("session-a", "sha-a");
    await writeRunnerRegistrationIdentity(directory, sidecar);
    const factory = countingFactory("real");
    const storage = openStorage(factory.workerFactory);
    const readSqliteIdentity = vi.spyOn(storage, "readSqliteIdentity");

    await expect(recoverRunnerDirectoryIdentity(directory, undefined, storage))
      .resolves.toEqual({ sessionId: "session-a", codeSha: "sha-a" });
    expect(readSqliteIdentity).not.toHaveBeenCalled();
    expect(factory.created).toBe(0);

    await writeFile(join(directory, "runner-identity.json"), "{damaged");
    await expect(recoverRunnerDirectoryIdentity(directory, undefined, storage))
      .resolves.toEqual({ sessionId: "session-a", codeSha: "sha-a" });
    expect(readSqliteIdentity).toHaveBeenCalledTimes(1);

    await rm(database.databasePath, { force: true });
    await expect(recoverRunnerDirectoryIdentity(directory, undefined, storage))
      .resolves.toBeNull();
  });

  it("re-emits lifecycle summary rename notices from the real worker", async () => {
    const fixture = await createDatabase({ events: ["one"] });
    const lifecycle = RunnerSqliteLifecycle.open(fixture.databasePath);
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-notice",
      progressedAt: "2026-11-11T00:00:01.000Z",
    });
    lifecycle.close();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const storage = openStorage(countingFactory("notice").workerFactory);

    try {
      await expect(storage.readAuthoritativeLifecycle({
        databasePath: fixture.databasePath,
        sessionId: "session-a",
      })).resolves.toMatchObject({ execution_command_id: "execute-notice" });
      expect(warning).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(
          "Runner lifecycle summary rename retries exhausted "
          + "(EPERM: persistent lock; consecutive=3; severity=error): "
          + "/tmp/session-a/runner-lifecycle.json",
        ),
        { code: "RUNNER_LIFECYCLE_SUMMARY_RENAME_PERSISTENT" },
      );
      expect(warning).toHaveBeenNthCalledWith(
        2,
        "Runner lifecycle summary rename recovered after 3 failures: "
        + "/tmp/session-a/runner-lifecycle.json",
        { code: "RUNNER_LIFECYCLE_SUMMARY_RENAME_RECOVERED" },
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps the parent heartbeat running while the worker is gated", async () => {
    const fixture = await createDatabase({ events: ["one"] });
    const lifecycle = RunnerSqliteLifecycle.open(fixture.databasePath);
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-gated",
      progressedAt: "2026-11-11T00:00:01.000Z",
    });
    lifecycle.close();
    const signal = new SharedArrayBuffer(4);
    const release = new SharedArrayBuffer(4);
    const storage = openStorage(countingFactory("gate", { signal, release }).workerFactory);
    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
    }, 10);

    try {
      const pending = storage.readAuthoritativeLifecycle({
        databasePath: fixture.databasePath,
        sessionId: "session-a",
      });
      await waitForAtomics(signal, 1, 5000);
      const beatsAtGate = beats;
      await sleep(60);
      expect(beats).toBeGreaterThan(beatsAtGate);
      Atomics.store(new Int32Array(release), 0, 1);
      Atomics.notify(new Int32Array(release), 0);
      await expect(pending).resolves.toMatchObject({
        execution_command_id: "execute-gated",
      });
    } finally {
      clearInterval(timer);
    }
  });

  it("fails a crashed worker request once and shares one new client across the next calls", async () => {
    const fixture = await createDatabase({ events: ["one"] });
    const lifecycle = RunnerSqliteLifecycle.open(fixture.databasePath);
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-crash",
      progressedAt: "2026-11-11T00:00:01.000Z",
    });
    lifecycle.close();
    const signal = new SharedArrayBuffer(4);
    const release = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    const factory = countingFactory("gate", { signal, release }, (worker) => {
      workers.push(worker);
    });
    const storage = openStorage(factory.workerFactory);
    const startedPhases: string[] = [];
    const finishedPhases: string[] = [];
    let now = 0;
    const observation = createRunnerPhaseObservation({
      nodeId: "node-test",
      scopeId: "recovery-crash",
      operation: "runnerRecovery.scan",
      logger: { warn: vi.fn() },
      monotonicNow: () => now++,
      beginRunnerOperation: ({ phase }) => {
        startedPhases.push(phase ?? "");
        return () => finishedPhases.push(phase ?? "");
      },
    });

    const pending = storage.readAuthoritativeLifecycle(
      { databasePath: fixture.databasePath, sessionId: "session-a" },
      observation,
    );
    await waitForAtomics(signal, 1, 5000);
    expect(workers).toHaveLength(1);
    await workers[0]!.terminate();

    await expect(pending).rejects.toThrow(/worker failed|exited/);
    await sleep(50);
    expect(factory.created).toBe(1);
    await vi.waitFor(() => {
      expect([...finishedPhases].sort()).toEqual([...startedPhases].sort());
    });

    // Both calls see the same dead client; they must share one replacement
    // instead of each spawning a worker and orphaning the other.
    const identities = await Promise.all([
      storage.readSqliteIdentity({ databasePath: fixture.databasePath }),
      storage.readSqliteIdentity({ databasePath: fixture.databasePath }),
    ]);
    for (const identity of identities) {
      expect(identity).toMatchObject({ sessionId: "session-a", codeSha: "sha-a" });
    }
    expect(factory.created).toBe(2);
  });

  it("shares one recovery worker across registrations and keeps it separate from an outbox worker", async () => {
    const stateDirectory = await temporaryDirectory("composition");
    const first = await createDatabase({ directory: join(stateDirectory, "a") });
    const second = await createDatabase({ directory: join(stateDirectory, "b") });
    const exits: Array<Promise<number>> = [];
    const recoveryFactory = countingFactory("real", {}, (worker) => {
      exits.push(new Promise<number>((resolve) => worker.once("exit", resolve)));
    });
    const storage = openStorage(recoveryFactory.workerFactory);

    for (const fixture of [first, second, first]) {
      await expect(storage.readSqliteIdentity({ databasePath: fixture.databasePath }))
        .resolves.toMatchObject({ sessionId: "session-a" });
    }
    expect(recoveryFactory.created).toBe(1);

    const outboxFactory = countingFactory("real");
    const outbox = await RunnerParentOutbox.open(
      first.databasePath,
      "session-a",
      { workerFactory: outboxFactory.workerFactory },
    );
    outboxes.push(outbox);
    await expect(outbox.readBootstrap()).resolves.toMatchObject({ stream_id: first.streamId });
    expect(outboxFactory.created).toBe(1);
    expect(recoveryFactory.created).toBe(1);

    await outbox.close();
    await storage.close();
    await expect(Promise.all(exits)).resolves.toHaveLength(1);
  });

  it("closes a temporary facade after a standalone helper call", async () => {
    const fixture = await createDatabase({ events: ["one"] });
    const factory = countingFactory("real");
    const storage = new RunnerRecoveryStorage({ workerFactory: factory.workerFactory });

    await expect(withRunnerRecoveryStorage(storage, async (current) =>
      await current.readSqliteIdentity({ databasePath: fixture.databasePath })))
      .resolves.toMatchObject({ sessionId: "session-a" });
    expect(factory.created).toBe(1);

    await storage.close();
    await expect(storage.readSqliteIdentity({ databasePath: fixture.databasePath }))
      .rejects.toThrow("runner recovery storage is closed");
  });
});

interface DatabaseFixture {
  directory: string;
  databasePath: string;
  streamId: string | null;
  latestSourceSeq: number;
}

async function createDatabase(options: {
  directory?: string;
  sessionId?: string;
  events?: string[];
  bootstrap?: boolean;
  engineFrames?: number;
  interventions?: string[];
} = {}): Promise<DatabaseFixture> {
  const directory = options.directory ?? await temporaryDirectory("recovery");
  const sessionId = options.sessionId ?? "session-a";
  await mkdir(directory, { recursive: true });
  const databasePath = join(directory, "runner.sqlite");
  const writer = await RunnerSqliteEventOutbox.create(databasePath, { sessionId });
  try {
    if (options.bootstrap === false) {
      return { directory, databasePath, streamId: null, latestSourceSeq: 0 };
    }
    const bootstrap = await writer.initializeBootstrap({
      session_id: sessionId,
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
    });
    for (const content of options.events ?? []) {
      await writer.append(eventInput(sessionId, content));
    }
    for (let index = 0; index < (options.engineFrames ?? 0); index += 1) {
      await writer.appendEngineFrame(eventInput(sessionId, `frame-${index}`), {
        protocolVersion: 1,
        channel: "event",
        kind: "engine_event",
        payload: { type: "assistant_message", content: `frame-${index}` },
      });
    }
    for (const interventionId of options.interventions ?? []) {
      await writer.stageIntervention({
        interventionId,
        message: { type: "intervention", content: interventionId },
        queued: true,
        queuedAt: "2026-11-11T00:00:02.000Z",
      });
    }
    return {
      directory,
      databasePath,
      streamId: bootstrap.stream_id,
      latestSourceSeq: writer.latestDurableSourceSeq(),
    };
  } finally {
    writer.close();
  }
}

async function createRegistration(
  stateDirectory: string,
  sessionId: string,
  options: { lifecycleState: "running" | "closed"; acknowledgeHead?: boolean },
): Promise<{ paths: ReturnType<typeof runnerProcessPaths>; commandId: string }> {
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const fixture = await createDatabase({
    directory: paths.sessionDirectory,
    sessionId,
    events: ["one"],
  });
  const commandId = `execute-${sessionId}`;
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, sessionId);
  lifecycle.begin({
    pid: process.pid,
    commandId,
    progressedAt: "2026-11-11T00:00:01.000Z",
  });
  if (options.lifecycleState === "closed") {
    lifecycle.finish(commandId, "closed", "2026-11-11T00:00:02.000Z");
  }
  lifecycle.close();
  if (options.acknowledgeHead) {
    acknowledgeThroughHead(
      paths.databasePath,
      fixture.streamId!,
      sessionId,
      fixture.latestSourceSeq,
    );
  }
  await writeFile(paths.configPath, JSON.stringify({
    ...configFor(sessionId, paths),
  }));
  await writeRunnerRegistrationIdentity(
    paths.sessionDirectory,
    pendingRunnerRegistrationIdentity(sessionId, "sha-a"),
  );
  return { paths, commandId };
}

function configFor(
  sessionId: string,
  paths: ReturnType<typeof runnerProcessPaths>,
) {
  return {
    schemaVersion: 1 as const,
    sessionId,
    backend: "codex" as const,
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex" as const,
      workspace_dir: "/workspace/session-a",
    },
    paths,
    codeSha: "sha-a",
    snapshotPath: "/releases/sha-a/soul-server-ts",
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/workspace/session-a/.codex",
    rolloutRoot: "/workspace/session-a/.codex/sessions",
  };
}

function registrationFor(
  databasePath: string,
  sessionId: string,
  closedTailState?: RunnerRegistration["closedTailState"],
): RunnerRegistration {
  const directory = dirname(databasePath);
  const paths = {
    sessionDirectory: directory,
    databasePath,
    socketPath: join(directory, "runner.sock"),
    socketKind: "unix_socket" as const,
    pidPath: join(directory, "runner.pid"),
    lockPath: join(directory, "runner.lock"),
    configPath: join(directory, "runner-config.json"),
    logPath: join(directory, "runner.log"),
  };
  let lifecycle: ReturnType<typeof readRunnerSqliteLifecycle> = null;
  try {
    lifecycle = readRunnerSqliteLifecycle(databasePath);
  } catch {
    // The fast-path fixtures intentionally have no database.
  }
  return {
    config: configFor(sessionId, paths),
    pid: null,
    pidAlive: false,
    registeredAtMs: 0,
    bootstrap: null,
    lifecycle,
    ...(closedTailState ? { closedTailState } : {}),
  };
}

function beginLifecycle(databasePath: string, commandId: string): void {
  const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
  try {
    lifecycle.begin({
      pid: process.pid,
      commandId,
      progressedAt: "2026-11-11T00:00:01.000Z",
    });
  } finally {
    lifecycle.close();
  }
}

function acknowledgeThroughHead(
  databasePath: string,
  streamId: string,
  sessionId: string,
  acknowledgedThrough: number,
): void {
  const store = RunnerHostStateStore.open(
    runnerHostStatePath(databasePath),
    undefined,
    { sessionId },
  );
  try {
    store.initializeEventCheckpoint({ streamId, sessionId, acknowledgedThrough });
  } finally {
    store.close();
  }
}

function eventInput(sessionId: string, content: string): EventOutboxAppendInput {
  return {
    session_id: sessionId,
    event_type: "assistant_message",
    payload: { type: "assistant_message", content },
    searchable_text: content,
    created_at: "2026-11-11T00:00:01.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
  };
}

function countingFactory(
  mode: FixtureMode,
  extras: { signal?: SharedArrayBuffer; release?: SharedArrayBuffer } = {},
  onWorker?: (worker: Worker) => void,
): {
  created: number;
  workerFactory: (workerData: Record<string, unknown>) => Worker;
} {
  const entryUrl = new URL("./fixtures/runner_parent_storage_test_worker.ts", import.meta.url)
    .href;
  const result = {
    created: 0,
    workerFactory: (workerData: Record<string, unknown>): Worker => {
      result.created += 1;
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
    },
  };
  return result;
}

function openStorage(
  workerFactory: (workerData: Record<string, unknown>) => Worker,
): RunnerRecoveryStorage {
  const storage = new RunnerRecoveryStorage({ workerFactory });
  storages.push(storage);
  return storage;
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `runner-recovery-${label}-`));
  tempDirectories.push(directory);
  return directory;
}

async function waitForAtomics(
  buffer: SharedArrayBuffer,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const view = new Int32Array(buffer);
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(view, 0) !== expected) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the worker gate");
    await sleep(5);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
