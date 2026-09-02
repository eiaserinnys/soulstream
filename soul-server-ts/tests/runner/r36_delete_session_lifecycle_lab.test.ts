import { rm } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { registerCatalogTools } from "../../src/mcp/tools/catalog.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import type { RunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import type {
  RunnerRegistration,
  RunnerRegistrationScan,
} from "../../src/runner/runner_process_registry.js";
import { readRunnerRegistrationSummary } from
  "../../src/runner/runner_registration_reader.js";
import { readRunnerRegistrationIdentity } from
  "../../src/runner/runner_registration_identity.js";
import { RunnerRecoveryCoordinator } from
  "../../src/runner/runner_recovery_coordinator.js";
import {
  RunnerSessionGarbageCollector,
  type RunnerSessionGarbageCollectorDependencies,
} from "../../src/runner/runner_session_gc.js";
import {
  TaskLifecycleRoute,
  type TaskLifecycleTransitionPort,
} from "../../src/task/task_lifecycle_route.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import {
  durableMissingSessionFixture,
  pathExists,
} from "./r36b_missing_session_fixture.js";

const ACTIVE_SESSION = "delete-active";
const LEGACY_RESIDUE = "1ed01abc-residue";
const STARTED_AT = Date.parse("2026-09-01T00:00:00.000Z");

describe("R36 delete_session lifecycle lab", () => {
  it("drains an active runner and converges both new and legacy deleted-session evidence", async () => {
    let now = STARTED_AT;
    let runnerAlive = true;
    const trace: string[] = [];
    const centralSessions = new Set([ACTIVE_SESSION]);
    const registrations = new Map([
      [ACTIVE_SESSION, registration(ACTIVE_SESSION, { pidAlive: true })],
      [LEGACY_RESIDUE, registration(LEGACY_RESIDUE, {
        pid: null,
        pidAlive: false,
        pidStartIdentity: null,
      })],
    ]);
    const activeTask = task(ACTIVE_SESSION);
    const tasks = new Map([[ACTIVE_SESSION, activeTask]]);

    const dispatcher = {
      interrupt: vi.fn(async () => true),
      close: vi.fn(async () => {
        trace.push("runner-close");
        runnerAlive = false;
        registrations.get(ACTIVE_SESSION)!.pidAlive = false;
      }),
      retireTerminalRegistration: vi.fn(async () => {
        trace.push("retire-registration");
        const current = registrations.get(ACTIVE_SESSION)!;
        current.pid = null;
        current.pidStartIdentity = null;
        current.retiredAt = new Date(now).toISOString();
      }),
    } as unknown as RunnerCommandDispatcher;
    activeTask.runner = {
      engine: {} as never,
      dispatcher,
      eventPersistence: "runner",
    };

    const lifecycleTransition = {
      cancelRunningTask: vi.fn(async () => true),
      interruptAndDrain: vi.fn(async () => {
        trace.push("interrupt-and-drain");
      }),
      markRunningTaskInterruptedForShutdown: vi.fn(async () => {}),
      interruptForShutdown: vi.fn(async () => {}),
      getDrainPromise: vi.fn(() => undefined),
      finalizeExternalTask: vi.fn(async (candidate: Task) => candidate),
    } satisfies TaskLifecycleTransitionPort;
    const route = new TaskLifecycleRoute({
      getTask: (sessionId) => tasks.get(sessionId),
      listTasks: () => Array.from(tasks.values()),
      forgetTask: (sessionId) => { tasks.delete(sessionId); },
      lifecycleTransition,
      closeSessionRuntime: async () => {
        trace.push("runtime-close");
        return true;
      },
      sessionMutations: {
        deleteSession: vi.fn(async (sessionId: string) => {
          trace.push("central-delete");
          centralSessions.delete(sessionId);
        }),
      } as never,
      broadcaster: {
        emitSessionDeleted: vi.fn(async () => {
          trace.push("session-deleted");
        }),
      } as never,
      logger: silentLogger(),
    });

    const taskManager = {
      deleteTask: async (sessionId: string) => await route.deleteTask(sessionId),
      hydrateRunnerRecoveryTask: vi.fn(async (sessionId: string) =>
        centralSessions.has(sessionId) ? tasks.get(sessionId) ?? task(sessionId) : null),
      markRunnerFailureAndResume: vi.fn(async () => {}),
      projectClosedRunner: vi.fn(async () => true),
    } as unknown as TaskManager;
    const catalogService = {
      // RED seam: the legacy handler deletes only the central row.
      deleteSession: vi.fn(async (sessionId: string) => {
        centralSessions.delete(sessionId);
      }),
      broadcastSessionDeletion: vi.fn(async () => {
        trace.push("catalog-deleted");
      }),
    } as unknown as CatalogService;
    const handlers = new Map<string, Function>();
    const server = {
      registerTool(name: string, _config: unknown, handler: Function) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerCatalogTools(server, {
      db: {
        getBoardItemIdsForSession: vi.fn(async () => ["board-active"]),
      } as unknown as SessionDB,
      taskManager,
      catalogService,
    } as unknown as McpRuntime);

    await handlers.get("delete_session")!({ session_id: ACTIVE_SESSION });

    const removed: string[] = [];
    const gc = new RunnerSessionGarbageCollector(
      "/state",
      1_000,
      silentLogger(),
      {
        now: () => now,
        withMutationLock: async <T>(_path: string, operation: () => Promise<T>) =>
          await operation(),
        refresh: async (candidate) => registrations.get(candidate.config.sessionId)!,
        inspect: async (candidate) => ({
          registration: registrations.get(candidate.config.sessionId)!,
          acknowledgedThrough: 2,
          latestDurableSourceSeq: 3,
          incompleteDurableWork: true,
          durableRecordCount: 3,
          unacknowledgedIpcFrameCount: 1,
          pendingInterventionCount: 0,
        }),
        removeDirectory: async (path) => {
          const sessionId = path.slice("/state/".length);
          removed.push(sessionId);
          registrations.delete(sessionId);
        },
      } satisfies RunnerSessionGarbageCollectorDependencies,
    );
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const retireReleasedRegistration = vi.fn(async (
      _paths: unknown,
      _expected: unknown,
      released: RunnerRegistration,
      confirmRetirementStillValid: () => Promise<boolean>,
    ) => {
      expect(await confirmRetirementStillValid()).toBe(true);
      const current = registrations.get(released.config.sessionId)!;
      current.retiredAt = new Date(now).toISOString();
      return "registration_absent" as const;
    });
    const coordinator = new RunnerRecoveryCoordinator({
      nodeId: "node-a",
      stateDirectory: "/state",
      leaseTimeoutMs: 1_000,
      scanIntervalMs: 15_000,
      taskManager,
      taskExecutor: {
        recoverRegisteredRunner: vi.fn(async () => {}),
        restartRegisteredRunner: vi.fn(),
      },
      closedTailDrainer: { drain: vi.fn(async () => {}) },
      logger,
      spawner: {
        terminate: retireReleasedRegistration,
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration: vi.fn(async () => {}),
      },
      scan: async (): Promise<RunnerRegistrationScan> => ({
        registrations: Array.from(registrations.values()),
        errors: [],
      }),
      hydrate: async (candidate) => candidate,
      now: () => now,
      sessionGarbageCollector: gc,
    });

    await coordinator.scanOnce();
    await vi.waitFor(() => {
      expect(registrations.get(LEGACY_RESIDUE)?.retiredAt).toBeTruthy();
    });
    now += 60 * 60 * 1_000 + 1_001;
    await coordinator.scanOnce();
    await vi.waitFor(() => {
      expect(removed.sort()).toEqual([ACTIVE_SESSION, LEGACY_RESIDUE].sort());
    });

    expect(runnerAlive).toBe(false);
    expect(retireReleasedRegistration).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(trace).toEqual([
      "interrupt-and-drain",
      "runtime-close",
      "runner-close",
      "retire-registration",
      "central-delete",
      "session-deleted",
      "catalog-deleted",
    ]);
  });

  it("retires and garbage-collects a missing session with only a terminal historical pid", async () => {
    let now = STARTED_AT;
    const fixture = await durableMissingSessionFixture("reaped", () => now);
    const logger = testLogger();
    const taskManager = missingSessionTaskManager();
    const coordinator = new RunnerRecoveryCoordinator({
      nodeId: "node-a",
      stateDirectory: fixture.stateDirectory,
      leaseTimeoutMs: 1_000,
      scanIntervalMs: 15_000,
      taskManager,
      taskExecutor: recoveryTaskExecutor(),
      closedTailDrainer: { drain: vi.fn(async () => {}) },
      logger,
      spawner: fixture.spawner,
      now: () => now,
      sessionGarbageCollector: new RunnerSessionGarbageCollector(
        fixture.stateDirectory,
        1_000,
        logger,
      ),
    });

    try {
      const initial = await readRunnerRegistrationSummary(
        fixture.paths.sessionDirectory,
        { verifyProcessIdentity: true },
      );
      expect(initial).toMatchObject({
        pid: fixture.historicalPid,
        pidAlive: false,
        pidStartIdentity: null,
        retiredAt: null,
        lifecycle: {
          runner_pid: fixture.historicalPid,
          execution_state: "reaped",
          terminal_error: { code: "runner_exited" },
        },
      });
      expect(await readRunnerRegistrationIdentity(fixture.paths.sessionDirectory))
        .toMatchObject({ pid: null, startIdentity: null });
      expect(await Promise.all([
        pathExists(fixture.paths.pidPath),
        pathExists(fixture.paths.lockPath),
        pathExists(fixture.paths.socketPath),
      ])).toEqual([false, false, false]);

      await coordinator.scanOnce();
      await coordinator.waitForSettled();

      expect((await readRunnerRegistrationIdentity(
        fixture.paths.sessionDirectory,
      ))?.retiredAt).toBeTruthy();
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "runner registration has no durable session",
      );

      now += 60 * 60 * 1_000 + 1_001;
      await coordinator.scanOnce();
      await coordinator.waitForSettled();
      await coordinator.stop();

      expect(await pathExists(fixture.paths.sessionDirectory)).toBe(false);
    } finally {
      await coordinator.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps a missing session with a non-terminal historical lifecycle pid", async () => {
    const fixture = await durableMissingSessionFixture("running", () => STARTED_AT);
    const logger = testLogger();
    const taskManager = missingSessionTaskManager();
    const terminate = vi.spyOn(fixture.spawner, "terminate");
    const coordinator = new RunnerRecoveryCoordinator({
      nodeId: "node-a",
      stateDirectory: fixture.stateDirectory,
      leaseTimeoutMs: 1_000,
      scanIntervalMs: 15_000,
      taskManager,
      taskExecutor: recoveryTaskExecutor(),
      closedTailDrainer: { drain: vi.fn(async () => {}) },
      logger,
      spawner: fixture.spawner,
      now: () => STARTED_AT,
    });

    try {
      const initial = await readRunnerRegistrationSummary(
        fixture.paths.sessionDirectory,
        { verifyProcessIdentity: true },
      );
      expect(initial).toMatchObject({
        pid: fixture.historicalPid,
        pidAlive: false,
        pidStartIdentity: null,
        lifecycle: { execution_state: "running" },
      });

      await coordinator.scanOnce();
      await coordinator.waitForSettled();

      expect(terminate).not.toHaveBeenCalled();
      expect((await readRunnerRegistrationIdentity(
        fixture.paths.sessionDirectory,
      ))?.retiredAt).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        { sessionId: fixture.sessionId },
        "runner registration has no durable session",
      );
    } finally {
      await coordinator.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function task(agentSessionId: string): Task {
  return {
    agentSessionId,
    prompt: "R36 lab",
    status: "running",
    createdAt: new Date(STARTED_AT),
    lastEventId: 1,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function registration(
  sessionId: string,
  options: {
    pid?: number | null;
    pidAlive: boolean;
    pidStartIdentity?: string | null;
  },
): RunnerRegistration {
  return {
    config: {
      sessionId,
      codeSha: "release-r36",
      paths: {
        sessionDirectory: `/state/${sessionId}`,
        databasePath: `/state/${sessionId}/runner.sqlite`,
        lockPath: `/state/${sessionId}/runner.lock`,
      },
    } as never,
    pid: options.pid === undefined ? 4123 : options.pid,
    pidAlive: options.pidAlive,
    registeredAtMs: STARTED_AT - 60_000,
    registrationId: `registration-${sessionId}`,
    pidStartIdentity: options.pidStartIdentity === undefined
      ? "start-4123"
      : options.pidStartIdentity,
    retiredAt: null,
    bootstrap: { payload: { code_sha: "release-r36" } } as never,
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: `execute-${sessionId}`,
      execution_state: "running",
      progress_seq: 2,
      progress_at: new Date(STARTED_AT - 60_000).toISOString(),
      liveness_at: new Date(STARTED_AT - 60_000).toISOString(),
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

function silentLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as never;
}

function missingSessionTaskManager(): TaskManager {
  return {
    hydrateRunnerRecoveryTask: vi.fn(async () => null),
    markRunnerFailureAndResume: vi.fn(async () => {}),
    projectClosedRunner: vi.fn(async () => true),
  } as unknown as TaskManager;
}

function recoveryTaskExecutor() {
  return {
    recoverRegisteredRunner: vi.fn(async () => {}),
    restartRegisteredRunner: vi.fn(),
  };
}

function testLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as never;
}
