import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import {
  RunnerRecoveryCoordinator,
} from "../../src/runner/runner_recovery_coordinator.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import {
  TaskExecutor,
  type RunnerProcessRuntimeFactory,
} from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";

import { makeEventPersistenceTestDouble } from "../task/event_persistence_test_double.js";
import { makeOwnerlessRegistration } from
  "./ownerless_running_reconciliation_fixture.js";

const logger = pino({ level: "silent" });
const SESSION_ID = "wave0-reaped-no-replacement";
const NODE_ID = "node-wave0-replacement-pin";
const NOW_MS = Date.parse("2026-09-02T00:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("Wave 0 replacement boundary pin", () => {
  it("keeps a dead runner terminal without creating a replacement durable bootstrap", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "wave0-replacement-pin-"));
    temporaryDirectories.push(stateDirectory);
    const replacementPaths = runnerProcessPaths(stateDirectory, `${SESSION_ID}-replacement`);
    const persistenceDouble = makeEventPersistenceTestDouble(
      undefined,
      [],
      { capabilityProfile: "legacy_transition_only" },
    );
    const db = {
      listOwnerNullRunningInventory: async () => [],
    } as unknown as SessionDB;
    const broadcaster = {
      emitEventEnvelope: async () => undefined,
      emitSessionUpdated: async () => undefined,
    } as unknown as SessionBroadcaster;
    const task: Task = {
      agentSessionId: SESSION_ID,
      prompt: "the original turn only",
      status: "running",
      createdAt: new Date(NOW_MS),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const replacementRunner = durableReplacementRunner(replacementPaths.databasePath);
    const runnerFactory = (() => replacementRunner) as RunnerProcessRuntimeFactory;
    runnerFactory.recover = () => offlineRecoveryRunner();
    runnerFactory.restart = () => replacementRunner;
    const taskExecutor = new TaskExecutor(
      () => { throw new Error("replacement pin must use the process runtime"); },
      db,
      persistenceDouble.persistence,
      broadcaster,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runnerFactory,
    );
    const taskManager = new TaskManager(
      NODE_ID,
      db,
      broadcaster,
      logger,
      persistenceDouble.persistence,
    );
    (taskManager as unknown as { tasks: Map<string, Task> }).tasks.set(SESSION_ID, task);
    const base = makeOwnerlessRegistration(SESSION_ID, NOW_MS, {
      pidAlive: false,
      progressedAtMs: NOW_MS - 120_001,
    });
    const registration = {
      ...base,
      lifecycle: {
        ...base.lifecycle!,
        execution_state: "running" as const,
      },
    };
    const coordinator = new RunnerRecoveryCoordinator({
      nodeId: NODE_ID,
      stateDirectory,
      leaseTimeoutMs: 120_000,
      scanIntervalMs: 15_000,
      logger,
      now: () => NOW_MS,
      scan: async () => ({ registrations: [registration], errors: [] }),
      hydrate: async (value) => value,
      markReaped: async () => undefined,
      spawner: {
        terminate: async () => undefined,
        invalidateRegistration: async () => undefined,
      },
      taskManager,
      taskExecutor,
      closedTailDrainer: { drain: async () => undefined },
    });

    await coordinator.scanOnce();
    await coordinator.waitForSettled();

    expect(task.status).toBe("error");
    expect(task.terminationReason).toBe("error_aborted");
    expect(await replacementBootstrapCount(replacementPaths.databasePath)).toBe(0);
  });
});

function offlineRecoveryRunner(): TaskRunnerRuntime {
  return {
    engine: {
      backendId: "codex",
      workspaceDir: "/workspace/wave0",
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    },
    dispatcher: {
      recoverFrames: async function* () {},
      waitForSessionAck: async () => 0,
      detachHost: async () => undefined,
      registrationId: () => "registration-ownerless-red",
    } as never,
    eventPersistence: "runner",
  };
}

function durableReplacementRunner(databasePath: string): TaskRunnerRuntime {
  return {
    engine: {
      backendId: "codex",
      workspaceDir: "/workspace/wave0",
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    },
    dispatcher: {
      prepareSession: async () => {
        const outbox = await RunnerSqliteEventOutbox.create(databasePath);
        await outbox.initializeBootstrap({
          session_id: SESSION_ID,
          created_at: new Date(NOW_MS).toISOString(),
          resume: {
            schema_version: 1,
            backend_session_id: "thread-wave0-replacement",
            cwd: "/workspace/wave0",
            codex_home: null,
            rollout_root: null,
            code_sha: "release-wave0-replacement",
            snapshot_path: "/release/wave0-replacement",
          },
        });
        outbox.close();
      },
      waitForSessionAck: async () => 0,
    } as never,
    eventPersistence: "runner",
  };
}

async function replacementBootstrapCount(databasePath: string): Promise<number> {
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const outbox = await RunnerSqliteEventOutbox.openReadOnly(databasePath);
  try {
    return (await outbox.readBootstrap()) === null ? 0 : 1;
  } finally {
    outbox.close();
  }
}
