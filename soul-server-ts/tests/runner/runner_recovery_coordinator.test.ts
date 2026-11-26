import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { CLAUDE_BACKGROUND_RUNNER_DEAD_SENTENCE } from
  "../../src/task/claude_background_retention_notice.js";
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import { TaskExecutorFinalizer } from "../../src/task/task_executor_finalizer.js";
import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import { SessionDataHostError } from "../../src/control_plane/session_data_host_client.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import { RunnerSessionGarbageCollector } from "../../src/runner/runner_session_gc.js";
import { RunnerRecoveryStorage } from "../../src/runner/runner_recovery_storage.js";
import { scanRunnerRegistrations, type RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { readRunnerRegistrationSummary } from "../../src/runner/runner_registration_reader.js";
import {
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import {
  runnerLifecycleSummaryPath,
  RunnerSqliteLifecycle,
} from "../../src/runner/sqlite_runner_lifecycle.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerHostStateStore, runnerHostStatePath } from "../../src/runner/runner_host_state_store.js";
import { ClosedRunnerTailDrainer } from "../../src/runner/closed_runner_tail_drainer.js";
import { RunnerAdoptionRejectedError } from
  "../../src/task/runner_adoption_rejected_error.js";
import { TaskHydrationFailedError } from "../../src/task/task_hydration_errors.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { listActiveTaskWorkspaceDirs } from "../../src/runtime/task_active_workspace_dirs.js";
import type { Task } from "../../src/task/task_models.js";
import { makeEventPersistenceTestDouble } from
  "../task/event_persistence_test_double.js";
import { makeDeliveryRepository } from "../task/delivery_repository_test_fake.js";

const RECOVERY_NOW_MS = Date.parse("2026-08-11T00:00:30.000Z");
const recoveryStorage = new RunnerRecoveryStorage();
afterAll(async () => { await recoveryStorage.close(); });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("RunnerRecoveryCoordinator exception matrix", () => {

  it("reads a retired completed runner's tail and starts a nonblocking drain", async () => {
    const fixture = await releasedTerminalSidecarFixture();
    try {
      const identity = await readRunnerRegistrationIdentity(fixture.paths.sessionDirectory);
      await writeRunnerRegistrationIdentity(fixture.paths.sessionDirectory, {
        ...identity!, retiredAt: "2026-08-11T00:00:30.000Z",
      });
      const writer = await RunnerSqliteEventOutbox.open(fixture.paths.databasePath);
      await writer.initializeBootstrap({
        session_id: "session-a", created_at: "2026-08-11T00:00:00.000Z",
        resume: {
          schema_version: 1, backend_session_id: "backend-a", cwd: "/workspace/a",
          codex_home: "/home/test/.codex", rollout_root: "/home/test/.codex/sessions",
          code_sha: "sha256-b271cc86", snapshot_path: "/release/a",
        },
      });
      await writer.append({
        session_id: "session-a", event_type: "assistant", payload: { text: "tail" },
        searchable_text: "tail", created_at: "2026-08-11T00:00:01.000Z",
        semantic_dedupe_key: null, session_effect: null,
      });
      const streamId = writer.streamId;
      writer.close();
      const host = RunnerHostStateStore.open(runnerHostStatePath(fixture.paths.databasePath));
      host.initializeEventCheckpoint({ streamId, sessionId: "session-a", acknowledgedThrough: 1 });
      host.close();
      const current = await readRunnerRegistrationSummary(fixture.paths.sessionDirectory, { recoveryStorage });
      expect(current.closedTailState).toMatchObject({
        status: "requires_drain", acknowledgedThrough: 1, latestDurableSourceSeq: 2,
      });
      const pending = deferred<void>();
      const registered = deferred<void>();
      const register = vi.fn((pump: import("../../src/upstream/event_outbox_pump.js").EventOutboxPump) => {
        pump.connect(async (batch) => {
          await pending.promise;
          await pump.handleAck({
            type: "event_append_ack", stream_id: batch.stream_id,
            acked_through: batch.events.at(-1)!.source_seq,
            events: batch.events.map((event) => ({ source_seq: event.source_seq, event_id: 100 + event.source_seq })),
          });
        });
        registered.resolve();
        return () => pump.disconnect();
      });
      const drainer = new ClosedRunnerTailDrainer({
        pumpMux: { register }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const drain = vi.spyOn(drainer, "drain");
      const subject = makeSubject([current], RECOVERY_NOW_MS, [], { closedTailDrainer: drainer });
      await expect(withinBudget(subject.coordinator.scanOnce(), 1_000)).resolves.toBeUndefined();
      expect(drain).toHaveBeenCalledOnce();
      await registered.promise;
      expect(register).toHaveBeenCalledOnce();
      await expect(withinBudget(subject.coordinator.scanOnce(), 1_000)).resolves.toBeUndefined();
      expect(drain).toHaveBeenCalledOnce();
      pending.resolve();
      await subject.coordinator.waitForSettled();
      expect(subject.logger.info).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-a", startAck: 1, endAck: 2, outcome: "acknowledged",
      }), "retired runner tail drain completed");
      const acknowledged = await readRunnerRegistrationSummary(fixture.paths.sessionDirectory, { recoveryStorage });
      const after = makeSubject([acknowledged], RECOVERY_NOW_MS, [], {
        closedTailDrainer: {
          drain: async (registration, phaseObservation) =>
            await drainer.drain(registration, phaseObservation),
        },
      });
      await after.coordinator.scanOnce();
      expect(drain).toHaveBeenCalledOnce();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("skips retired runners with a live pid, nonterminal lifecycle, or active stream pump", async () => {
    const live = retiredWithTail("live", "failed");
    live.pidAlive = true;
    const running = retiredWithTail("running", "running");
    const pumped = retiredWithTail("pumped", "failed");
    const drain = vi.fn(async () => {});
    const hasActivePump = vi.fn((streamId: string) => streamId === "stream-pumped");
    const subject = makeSubject([live, running, pumped], RECOVERY_NOW_MS, [], {
      closedTailDrainer: { drain, hasActivePump },
    });
    await subject.coordinator.scanOnce();
    expect(hasActivePump).toHaveBeenCalledWith("stream-pumped");
    expect(drain).not.toHaveBeenCalled();
  });

  it("retries a failed retired tail only after ten minutes", async () => {
    let now = RECOVERY_NOW_MS;
    const current = retiredWithTail("session-a", "failed");
    const drain = vi.fn(async () => {}).mockRejectedValueOnce(new Error("ACK timed out"));
    const subject = makeSubject([current], now, [], { now: () => now, closedTailDrainer: { drain } });
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(drain).toHaveBeenCalledOnce();
    now += 599_999;
    await subject.coordinator.scanOnce();
    expect(drain).toHaveBeenCalledOnce();
    now += 1;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("starts only one retired tail drain at a time", async () => {
    const first = retiredWithTail("first", "failed");
    const second = retiredWithTail("second", "completed");
    const pending = deferred<void>();
    const drain = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const subject = makeSubject([first, second], RECOVERY_NOW_MS, [], { closedTailDrainer: { drain } });
    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();
    expect(drain).toHaveBeenCalledOnce();
    pending.resolve();
    await subject.coordinator.waitForSettled();
    first.closedTailState = {
      status: "fully_acknowledged", streamId: "stream-first", sessionId: "first",
      latestDurableSourceSeq: 3, acknowledgedThrough: 3,
    };
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain.mock.calls[1]![0].config.sessionId).toBe("second");
  });

  it("sweeps once after the initial scan with every live and unreadable session protected", async () => {
    const waiting = { ...registration({ sessionId: "waiting" }), bootstrap: null, lifecycle: null };
    const retired = { ...registration({ sessionId: "retired", lifecycleState: "completed" }), retiredAt: "2026-08-11T00:00:00Z" };
    const replay = registration({ sessionId: "replay", lifecycleState: "completed" });
    const dead = registration({ sessionId: "dead", pidAlive: false, lifecycleState: "completed" });
    const sweep = vi.fn(async () => ({ queried: 0, closed: 0, skippedLive: 0, failed: 0 }));
    let now = RECOVERY_NOW_MS;
    const scan = vi.fn(async () => { now += 5_000; return ({
      registrations: [waiting, retired, replay, dead],
      errors: [{ directory: "/unreadable", error: new Error("unreadable"), sessionId: "uncertain" }],
    }); });
    const subject = makeSubject([], RECOVERY_NOW_MS, [], {
      scan, now: () => now, quarantineFailure: vi.fn(async () => ({ status: "missing" as const })),
      terminalizeOrphanedClaudeBackgroundTasks: sweep,
    });
    await subject.coordinator.start();
    expect(sweep).toHaveBeenCalledOnce();
    expect(sweep).toHaveBeenCalledWith({
      liveSessionIds: new Set(["waiting", "retired", "replay", "uncertain"]),
      updatedBefore: new Date(RECOVERY_NOW_MS), limit: 1_000,
    });
    expect(scan.mock.invocationCallOrder[0]!).toBeLessThan(sweep.mock.invocationCallOrder[0]!);
    await subject.coordinator.scanOnce();
    expect(sweep).toHaveBeenCalledOnce();
    await subject.coordinator.stop();
  });

  it("skips the sweep when a scan error has no session id", async () => {
    const sweep = vi.fn();
    const subject = makeSubject([], RECOVERY_NOW_MS, [{ directory: "/unreadable", error: new Error("unreadable") }], {
      quarantineFailure: vi.fn(async () => ({ status: "missing" as const })),
      terminalizeOrphanedClaudeBackgroundTasks: sweep,
    });
    await subject.coordinator.start();
    expect(sweep).not.toHaveBeenCalled();
    expect(subject.logger.warn).toHaveBeenCalled();
    await subject.coordinator.stop();
  });

  it("keeps the periodic scan running when the sweep rejects", async () => {
    const sweep = vi.fn(async () => { throw new Error("sweep failed"); });
    const subject = makeSubject([], RECOVERY_NOW_MS, [], {
      scanIntervalMs: 10, terminalizeOrphanedClaudeBackgroundTasks: sweep,
    });
    const scanOnce = vi.spyOn(subject.coordinator, "scanOnce");
    await expect(subject.coordinator.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(scanOnce.mock.calls.length).toBeGreaterThan(1));
    expect(subject.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining("orphan"));
    await subject.coordinator.stop();
  });

  it("does not wait for the orphan sweep before returning from start", async () => {
    const pending = deferred<{ queried: number; closed: number; skippedLive: number; failed: number }>();
    const sweep = vi.fn(() => pending.promise);
    const subject = makeSubject([], RECOVERY_NOW_MS, [], { terminalizeOrphanedClaudeBackgroundTasks: sweep });
    await expect(withinBudget(subject.coordinator.start(), 1_000)).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledOnce();
    pending.resolve({ queried: 0, closed: 0, skippedLive: 0, failed: 0 });
    await subject.coordinator.stop();
  });

  it("persists a scan and restores it before the next coordinator's first scan", async () => {
    const fixture = await releasedTerminalSidecarFixture();
    try {
      const stateDirectory = join(fixture.root, "runner-state");
      const identity = await readRunnerRegistrationIdentity(fixture.paths.sessionDirectory);
      await writeRunnerRegistrationIdentity(fixture.paths.sessionDirectory, {
        ...identity!, retiredAt: "2026-10-12T00:00:00.000Z",
      });
      const scan = scanRunnerRegistrations;
      const first = makeSubject([], RECOVERY_NOW_MS, [], { stateDirectory, scan });
      await first.coordinator.scanOnce();
      expect(JSON.parse(await readFile(join(stateDirectory, ".registration-scan-cache.json"), "utf8")).entries).toHaveLength(1);
      const second = makeSubject([], RECOVERY_NOW_MS, [], { stateDirectory, scan });
      await second.coordinator.scanOnce();
      expect(first.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ registrationCacheMisses: expect.objectContaining({ notCached: 1 }) }),
        "runner recovery scan completed",
      );
      expect(second.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ registrationCacheMisses: {
          uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 0,
        } }), "runner recovery scan completed",
      );
      expect(second.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ restored: 1, discarded: 0 }),
        "runner registration scan cache restored",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps auto-resume claimed until the exact old registration is retired", async () => {
    const terminalRegistration = registration({
      lifecycleState: "completed",
      pidAlive: true,
    });
    const recovered = task("session-a");
    recovered.status = "completed";
    recovered.terminationReason = "completed_ok";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 14;
    const closing = deferred<void>();
    const retirement = deferred<void>();
    let retirementFinished = false;
    const oldRunner = {
      engine: {
        codexDetachedCommandRuntime: true,
        codexDetachedCommandActivity: vi.fn(async () => ({
          activeForegroundCount: 0,
          detachedRunningCount: 0,
          retainedTerminalResultCount: 0,
          earliestRetainedTerminalDeadlineAtMs: null,
        })),
      },
      dispatcher: {
        close: vi.fn(() => closing.promise),
        registrationId: () => "registration-a",
        activeExecutionCommandId: () => undefined,
        hasActiveExecution: () => false,
      },
      eventPersistence: "runner",
    } as unknown as NonNullable<Task["runner"]>;
    const newRunner = finishedRunner("registration-new").runner;
    recovered.runner = oldRunner;
    recovered.runnerRetainedForDetachedWork = true;
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState: vi.fn(), notifyCompletionIfApplied: vi.fn() },
      logger: { warn: vi.fn() } as never,
    });
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner: vi.fn(async () => false),
        releaseExpiredRetainedRunner: async (
          owned: Task,
          exact: RunnerRegistration,
          recordedTerminal: boolean,
        ) => await finalizer.releaseExpiredRetainedRunner(
          owned,
          exact.registrationId!,
          recordedTerminal,
        ),
        completeRetainedRunnerReleaseAfterTermination: (
          owned: Task,
          exact: RunnerRegistration,
        ) => finalizer.completeRetainedRunnerReleaseAfterTermination(
          owned,
          exact.registrationId!,
        ),
      } as never,
    });
    subject.terminate.mockImplementation(async (...args) => {
      if (args.length < 3) return "registration_invalidated" as const;
      await retirement.promise;
      retirementFinished = true;
      return "registration_invalidated" as const;
    });
    const persistence = makeEventPersistenceTestDouble();
    const transition = new AutoResumeTransition({
      logger: subject.logger as never,
      persistence: persistence.persistence,
    });
    const message = { text: "new foreground", user: "human" };
    const onResume = vi.fn((owned: Task) => {
      expect(retirementFinished).toBe(true);
      owned.runner = newRunner;
      owned.status = "running";
    });

    const scan = subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(oldRunner.dispatcher.close).toHaveBeenCalledOnce());
    const resumed = transition.resume(recovered, message, onResume);
    await Promise.resolve();
    expect(recovered.status).toBe("completed");
    expect(recovered.runner).toBe(oldRunner);
    expect(persistence.enqueueRunningTransitionAndWaitForApplication)
      .not.toHaveBeenCalled();

    closing.resolve();
    await vi.waitFor(() => expect(subject.terminate).toHaveBeenCalledWith(
      terminalRegistration.config.paths,
      undefined,
      expect.objectContaining({ registrationId: "registration-a", pid: null }),
      expect.any(Function),
    ));
    expect(recovered.status).toBe("completed");
    expect(recovered.runner).toBe(oldRunner);
    expect(recovered.runnerReleaseClaim).toBeDefined();
    expect(onResume).not.toHaveBeenCalled();

    retirement.resolve();
    await scan;
    await resumed;

    expect(recovered.runner).toBe(newRunner);
    expect(recovered.runnerReleaseClaim).toBeUndefined();
    expect(onResume).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("keeps a failed-close claim and retries only the exact old registration", async () => {
    const terminalRegistration = registration({
      lifecycleState: "completed",
      pidAlive: true,
    });
    const recovered = task("session-a");
    recovered.status = "completed";
    recovered.terminationReason = "completed_ok";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 14;
    const runner = finishedRunner("registration-a").runner;
    recovered.runner = runner;
    recovered.runnerRetainedForDetachedWork = true;
    let resolveClaim!: () => void;
    const completion = new Promise<void>((resolve) => { resolveClaim = resolve; });
    recovered.runnerReleaseClaim = {
      runner,
      registrationId: "registration-a",
      completion,
      resolve: resolveClaim,
    };
    const complete = vi.fn((owned: Task) => {
      owned.runner = undefined;
      owned.runnerRetainedForDetachedWork = undefined;
      owned.runnerReleaseClaim = undefined;
      resolveClaim();
      return true;
    });
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner: vi.fn(async () => false),
        releaseExpiredRetainedRunner: vi.fn(async () => "retry_required" as const),
        completeRetainedRunnerReleaseAfterTermination: complete,
      } as never,
    });
    subject.terminate.mockRejectedValueOnce(new Error("termination failed"));

    await subject.coordinator.scanOnce();
    expect(recovered.runner).toBe(runner);
    expect(recovered.runnerReleaseClaim).toBeDefined();
    expect(complete).not.toHaveBeenCalled();

    await subject.coordinator.scanOnce();
    await expect(completion).resolves.toBeUndefined();
    expect(subject.terminate).toHaveBeenNthCalledWith(
      2,
      terminalRegistration.config.paths,
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate).toHaveBeenNthCalledWith(
      3,
      terminalRegistration.config.paths,
      undefined,
      expect.objectContaining({ registrationId: "registration-a", pid: null }),
      expect.any(Function),
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(recovered.runner).toBeUndefined();
    expect(recovered.runnerReleaseClaim).toBeUndefined();
  });

  it("keeps a retained terminal runner across repeated scans while its SDK live set is non-empty", async () => {
    const terminalRegistration = registration({
      lifecycleState: "completed",
      pidAlive: true,
    });
    const recovered = task("session-a");
    recovered.status = "completed";
    recovered.terminationReason = "completed_ok";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 14;
    const { runner, detachHost } = finishedRunner("registration-a");
    recovered.runner = runner;
    recovered.runnerRetainedForDetachedWork = true;
    const retainRegisteredDetachedRunner = vi.fn(async () => true);
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();

    expect(retainRegisteredDetachedRunner).toHaveBeenCalledTimes(2);
    expect(detachHost).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(recovered.runner).toBe(runner);
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedBy: "background",
        disposition: "replay_terminal",
        sessionId: "session-a",
      }),
      "registered runner recovery skipped because SDK background work owns the process",
    );
  });

  it.each([
    ["no open query", null],
    ["old runner", { status: "not_supported" }],
  ])("releases and retires a terminal Claude runner with %s", async (_label, activity) => {
    const terminalRegistration = registration({ lifecycleState: "completed", pidAlive: true });
    terminalRegistration.config.backend = "claude";
    terminalRegistration.config.agent.backend = "claude";
    const recovered = task("session-a");
    recovered.status = "completed";
    recovered.terminationReason = "completed_ok";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 14;
    const detachHost = vi.fn(async () => {});
    const dispatcher = {
      registrationId: () => "registration-a",
      hasActiveExecution: () => false,
      invoke: vi.fn(async () => activity),
      detachHost,
    };
    recovered.runner = {
      engine: new RunnerProcessEngineProxy("claude", "/workspace/a", dispatcher as never),
      dispatcher,
      eventPersistence: "runner",
    } as unknown as NonNullable<Task["runner"]>;
    recovered.runnerRetainedForDetachedWork = true;
    const executor = new TaskExecutor(
      () => { throw new Error("engine factory is unused"); },
      {} as never, {} as never, {} as never, { warn: vi.fn() } as never,
    );
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: { hydrateRunnerRecoveryTask: vi.fn(async () => recovered) } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner: (
          ...args: Parameters<typeof executor.retainRegisteredDetachedRunner>
        ) => executor.retainRegisteredDetachedRunner(...args),
      },
    });

    expect(listActiveTaskWorkspaceDirs([recovered], () => undefined)).toEqual(["/workspace/a"]);
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(detachHost).toHaveBeenCalledOnce();
    expect(recovered.runner).toBeUndefined();
    expect(listActiveTaskWorkspaceDirs([recovered], () => undefined)).toEqual([]);
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("replays a terminal registration with the exact old Claude closed error before retirement", async () => {
    const terminalRegistration = registration({
      lifecycleState: "failed",
      terminalError: {
        code: "execution_failed",
        message: "ClaudeEngineAdapter.execute called after close()",
      },
      pidAlive: true,
    });
    terminalRegistration.config.backend = "claude";
    terminalRegistration.config.agent.backend = "claude";
    const recovered = task("session-a");
    recovered.status = "error";
    recovered.terminationReason = "error_aborted";
    recovered.terminationDetail = "ClaudeEngineAdapter.execute called after close()";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 14;
    const retainRegisteredDetachedRunner = vi.fn(async () => true);
    const recoverRegisteredRunner = vi.fn(async () => undefined);
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner,
        recoverRegisteredRunner,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(retainRegisteredDetachedRunner).not.toHaveBeenCalled();
    expect(recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(recoverRegisteredRunner.mock.calls[0]?.slice(0, 4)).toEqual([
      recovered,
      expect.objectContaining({
        registrationId: "registration-a",
        lifecycle: expect.objectContaining({
          terminal_error: {
            code: "execution_failed",
            message: "ClaudeEngineAdapter.execute called after close()",
          },
        }),
      }),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
    ]);
  });

  it("adopts a live terminal registration before restart recovery can classify its background rows", async () => {
    const terminalRegistration = registration({
      lifecycleState: "completed",
      pidAlive: true,
    });
    const recovered = task("session-a");
    recovered.status = "completed";
    recovered.terminationReason = "completed_ok";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 14;
    const { runner } = finishedRunner("registration-a");
    const retainRegisteredDetachedRunner = vi.fn(async (owned: Task) => {
      owned.runner = runner;
      owned.runnerRetainedForDetachedWork = true;
      return true;
    });
    const terminalizeClaudeBackgroundTasks = vi.fn(async () => 0);
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner,
      } as never,
      terminalizeClaudeBackgroundTasks,
    } as never);

    await subject.coordinator.scanOnce();

    expect(retainRegisteredDetachedRunner).toHaveBeenCalledWith(
      recovered,
      expect.objectContaining({ registrationId: "registration-a" }),
    );
    expect(terminalizeClaudeBackgroundTasks).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(recovered.runner).toBe(runner);
  });

  it("releases a retained runner for a running registered task and enters offline replay", async () => {
    const terminalRegistration = registration({
      lifecycleState: "completed",
      pidAlive: true,
    });
    terminalRegistration.config.backend = "claude";
    terminalRegistration.config.agent.backend = "claude";
    const recovered = task("session-a");
    recovered.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:55555555-5555-4555-8555-555555555555",
    };
    recovered.runnerRetainedForDetachedWork = true;
    const detachHost = vi.fn(async () => {});
    recovered.runner = {
      engine: {
        backendId: "claude",
        detachedClaudeRuntime: true,
        detachedClaudeRuntimeActivity: vi.fn(async () => null),
      } as never,
      dispatcher: {
        registrationId: () => "registration-a",
        hasActiveExecution: () => false,
        detachHost,
      } as never,
      eventPersistence: "runner",
    } as NonNullable<Task["runner"]>;
    const executor = new TaskExecutor(
      () => { throw new Error("engine factory is unused in this recovery test"); },
      {} as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never,
    );
    const recoverRegisteredRunner = vi.fn(async () => {});
    const subject = makeSubject([terminalRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      taskExecutor: {
        retainRegisteredDetachedRunner: (
          ...args: Parameters<typeof executor.retainRegisteredDetachedRunner>
        ) => executor.retainRegisteredDetachedRunner(...args),
        recoverRegisteredRunner,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(detachHost).toHaveBeenCalledOnce();
    expect(recovered.runner).toBeUndefined();
    expect(recoverRegisteredRunner).toHaveBeenCalledWith(
      recovered,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.anything(),
    );
  });

  it.each([
    { lifecycleState: "running" as const, disposition: "reap_dead" },
    { lifecycleState: "completed" as const, disposition: "replay_terminal_dead" },
  ])("terminalizes only the proven-dead runner's Claude background rows for $disposition", async ({
    lifecycleState,
  }) => {
    const deadRegistration = registration({ lifecycleState, pidAlive: false });
    const terminalizeClaudeBackgroundTasks = vi.fn(async () => 1);
    const subject = makeSubject([deadRegistration], RECOVERY_NOW_MS, [], {
      terminalizeClaudeBackgroundTasks,
    } as never);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(terminalizeClaudeBackgroundTasks).toHaveBeenCalledOnce();
    expect(terminalizeClaudeBackgroundTasks).toHaveBeenCalledWith(
      "session-a",
      {
        registrationId: "registration-a",
        executionCommandId: "command:11111111-1111-4111-8111-111111111111",
      },
    );
  });

  it("죽은 러너의 백그라운드 작업은 부른 세션에 멈춤 알림을 정확히 1건 남긴다 (R3)", async () => {
    const deadRegistration = registration({ lifecycleState: "completed", pidAlive: false });
    const recovered = task("session-a");
    recovered.status = "completed";
    recovered.terminationReason = "completed_ok";
    recovered.terminationEventRecorded = true;
    recovered.terminalEventId = 22;
    recovered.completedAt = new Date("2026-08-11T00:00:00.000Z");
    recovered.callerSessionId = "session-parent";
    const rows = new Map<string, Record<string, unknown>>();
    const repository = makeDeliveryRepository(rows);
    const addIntervention = vi.fn(async (
      _params: { agentSessionId: string; text: string },
      _onResume: () => void,
    ) => ({ queued: true, queuePosition: 1 }));
    const notifier = new TaskCompletionNotifier(
      "node-1",
      { addIntervention } as never,
      { get: () => undefined } as never,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      true,
      repository as never,
    );
    const terminalizeClaudeBackgroundTasks = vi.fn(async () => 2);
    const subject = makeSubject([deadRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recovered),
      } as never,
      terminalizeClaudeBackgroundTasks,
      notifyDeadRunnerBackgroundStopped: async (deadTask: Task) =>
        await notifier.notifyBackgroundStopped(
          deadTask,
          CLAUDE_BACKGROUND_RUNNER_DEAD_SENTENCE,
        ),
    } as never);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(terminalizeClaudeBackgroundTasks).toHaveBeenCalledOnce();
    expect(addIntervention).toHaveBeenCalledOnce();
    const notice = addIntervention.mock.calls[0]![0] as {
      agentSessionId: string;
      text: string;
    };
    expect(notice.agentSessionId).toBe("session-parent");
    expect(notice.text).toBe(
      "백그라운드 작업을 돌리던 실행기가 끝나 작업이 멈췄습니다. 이 세션은 더 보고하지 않습니다.",
    );
  });


  it("턴을 끝낸 러너는 dispatcher가 열려 있어도 자기 replay를 막지 않는다", async () => {
    // The blocking handle is not an abandoned runner -- measured, it reports
    // `closed=false` while a *different* dispatcher is the one whose reconnect
    // budget ran out. It is the replacement turn's own runner, finished and
    // still attached, delivering nothing and refusing every replay for
    // thirteen fifteen-second scans (260822 lab F9).
    //
    // Detaching a terminal runner cannot strand a turn: the turn is over, and
    // what it has left is durable in its outbox, which is what the replay
    // reads.
    const finishedRegistration = registration({ lifecycleState: "completed", pidAlive: false });
    const strandedTask = task("session-a");
    strandedTask.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    let settleExecution!: () => void;
    const originalExecution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    }).finally(() => {
      strandedTask.executionPromise = undefined;
    });
    const { runner, detachHost, retireTerminalRegistration } = finishedRunner(
      "registration-a",
      undefined,
      async () => {
        strandedTask.status = "completed";
        strandedTask.terminationReason = "completed_ok";
        strandedTask.terminationEventRecorded = true;
        strandedTask.terminalEventId = 13;
        settleExecution();
      },
    );
    strandedTask.runner = runner;
    strandedTask.executionPromise = originalExecution;
    const subject = makeSubject([finishedRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => strandedTask),
      } as never,
    });

    await subject.coordinator.scanOnce();

    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(detachHost).not.toHaveBeenCalled();
    expect(strandedTask.runner).toBeUndefined();
    expect(strandedTask.executionPromise).toBeUndefined();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("defers terminal retirement when the pending turn belongs to another execution registration", async () => {
    const finishedRegistration = registration({ lifecycleState: "completed", pidAlive: false });
    const continuingTask = task("session-a");
    continuingTask.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:22222222-2222-4222-8222-222222222222",
    };
    const { runner, retireTerminalRegistration } = finishedRunner();
    continuingTask.runner = runner;
    continuingTask.executionPromise = new Promise<void>(() => {});
    const subject = makeSubject([finishedRegistration], RECOVERY_NOW_MS, [], {
      taskManager: { hydrateRunnerRecoveryTask: vi.fn(async () => continuingTask) } as never,
    });

    await subject.coordinator.scanOnce();

    expect(retireTerminalRegistration).not.toHaveBeenCalled();
    expect(continuingTask.runner).toBe(runner);
  });

  it("does not detach a terminal command while its execution generation opens a successor", async () => {
    // Live incident 260829: an intervention interrupted a tool-use turn, then
    // the same execution generation prepared its queued successor. Recovery
    // detached the shared dispatcher between compact and execute, so
    // startExecute read its released outbox and threw on
    // `inspectPendingInterventions`. The sessions-row generation is the owner
    // across both commands; a terminal command is not a terminal execution.
    const finishedRegistration = registration({
      lifecycleState: "completed",
      pidAlive: false,
    });
    const continuingTask = task("session-a");
    continuingTask.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "owner:successor-a",
    };
    const { runner, detachHost } = finishedRunner(
      "registration-a",
      "owner:successor-a",
    );
    const execution = new Promise<void>(() => {});
    continuingTask.runner = runner;
    continuingTask.executionPromise = execution;
    const subject = makeSubject([finishedRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => continuingTask),
      } as never,
    });

    await subject.coordinator.scanOnce();

    expect(detachHost).not.toHaveBeenCalled();
    expect(continuingTask.runner).toBe(runner);
    expect(continuingTask.executionPromise).toBe(execution);
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("retires a still-running registration after its exact session terminal is recorded", async () => {
    const finishedRegistration = registration({
      lifecycleState: "running",
      pidAlive: true,
    });
    const strandedTask = task("session-a");
    strandedTask.status = "error";
    strandedTask.terminationReason = "error_aborted";
    strandedTask.terminationDetail = "startup execution admission rejected";
    strandedTask.terminationEventRecorded = true;
    strandedTask.terminalEventId = 12;
    let settleExecution!: () => void;
    const originalExecution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    }).finally(() => {
      strandedTask.executionPromise = undefined;
    });
    const { runner, detachHost, retireTerminalRegistration } = finishedRunner(
      "registration-a",
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      async () => settleExecution(),
    );
    strandedTask.runner = runner;
    strandedTask.executionPromise = originalExecution;
    const subject = makeSubject([finishedRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => strandedTask),
      } as never,
    });

    await subject.coordinator.scanOnce();

    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(detachHost).not.toHaveBeenCalled();
    expect(strandedTask.runner).toBeUndefined();
    expect(strandedTask.executionPromise).toBeUndefined();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("settles the exact recovery admission before reaping a runner that died while lifecycle stayed running", async () => {
    const deadRegistration = registration({
      lifecycleState: "running",
      pidAlive: false,
    });
    const strandedTask = task("session-a");
    let settleExecution!: () => void;
    const originalExecution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    }).finally(() => {
      strandedTask.executionPromise = undefined;
    });
    const { runner, retireTerminalRegistration } = finishedRunner(
      "registration-a",
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      async () => {
        strandedTask.status = "error";
        strandedTask.terminationReason = "error_aborted";
        strandedTask.terminationEventRecorded = true;
        strandedTask.terminalEventId = 13;
        settleExecution();
      },
    );
    strandedTask.runner = runner;
    strandedTask.executionPromise = originalExecution;
    const subject = makeSubject([deadRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => strandedTask),
      } as never,
    });

    await subject.coordinator.scanOnce();

    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(strandedTask.executionPromise).toBeUndefined();
    expect(strandedTask.status).toBe("error");
    expect(strandedTask.terminationEventRecorded).toBe(true);
    expect(subject.markReaped).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("does not detach a live successor while replaying an older terminal registration", async () => {
    const finishedRegistration = registration({ lifecycleState: "completed", pidAlive: false });
    const currentTask = task("session-a");
    const { runner, detachHost } = finishedRunner("registration-new");
    const currentExecution = new Promise<void>(() => {});
    currentTask.runner = runner;
    currentTask.executionPromise = currentExecution;
    const subject = makeSubject([finishedRegistration], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => currentTask),
      } as never,
    });

    await subject.coordinator.scanOnce();

    expect(detachHost).not.toHaveBeenCalled();
    expect(currentTask.runner).toBe(runner);
    expect(currentTask.executionPromise).toBe(currentExecution);
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("호스트가 포기한 러너를 붙들고 offline replay를 막지 않는다", async () => {
    // Reconnect exhaustion announces that the execution "will be terminalized",
    // but the old path only detached the host. With no admission settlement
    // nothing propagated, the task kept the runner, and every
    // offline replay after it was refused -- the finished runner's output never
    // reached the session, which stayed running for good (260822 lab F9).
    const stranded = registration({ lifecycleState: "completed", pidAlive: false });
    const strandedTask = task("session-a");
    strandedTask.runner = abandonedRunner();
    const subject = makeSubject([stranded], RECOVERY_NOW_MS, [], {
      nodeStallMonitor: { beginRunnerOperation: vi.fn(() => vi.fn()) } as never,
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => strandedTask),
      } as never,
    });

    await subject.coordinator.scanOnce();

    expect(strandedTask.runner).toBeUndefined();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-a" }),
      expect.anything(),
      expect.anything(),
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
  });

  it("isolates a malformed registration classification and recovers later sessions", async () => {
    const malformed = registration({
      sessionId: "session-malformed",
      lifecycleState: "running",
      progressedAt: "not-a-timestamp",
    });
    const healthy = registration({ sessionId: "session-healthy", lifecycleState: "running" });
    const subject = makeSubject([malformed, healthy]);

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-healthy" }),
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: expect.stringContaining("timestamp invalid") }),
        sessionId: "session-malformed",
      }),
      "runner recovery classification failed",
    );
  });

  it("adopts a live registered runner before its first durable bootstrap event", async () => {
    const pending = {
      ...registration(),
      bootstrap: null,
      lifecycle: null,
    };
    const subject = makeSubject([pending]);

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      undefined,
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(subject.terminate).not.toHaveBeenCalled();
  });

  it("adopts a live runner whose execution is still running", async () => {
    const subject = makeSubject([registration({ lifecycleState: "running" })]);

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(subject.terminate).not.toHaveBeenCalled();
  });

  it("recovers a live registered owner-null runner on the first scan", async () => {
    const recoveredTask = task("session-a");
    recoveredTask.hydratedFromDb = true;
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recoveredTask),
        projectClosedRunner: vi.fn(async () => true),
      },
    });

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      recoveredTask,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(subject.terminate).not.toHaveBeenCalled();
  });

  it("adopts a hydrated sessions-row owner without owner-null reconciliation", async () => {
    const recoveredTask = task("session-a");
    recoveredTask.hydratedFromDb = true;
    recoveredTask.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "owner:stable-a",
    };
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recoveredTask),
        projectClosedRunner: vi.fn(async () => true),
      },
    });

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      recoveredTask,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
  });

  it("reaps and terminalizes when adoption loses a runner before its socket becomes available", async () => {
    const socketError = runnerSocketMissingError();
    const failedRunner = failedRecoveryRunner();
    const recoverRegisteredRunner = vi.fn((
      recovered: Task,
      _config: unknown,
      _commandId: unknown,
      mode: string,
      onAttemptCreated?: (runner: NonNullable<Task["runner"]>) => void,
    ) => {
      if (mode === "offline") return Promise.resolve();
      const failure = Promise.reject(socketError);
      onAttemptCreated?.(failedRunner.runner);
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = failure;
      return failure;
    });
    const current = registration({ lifecycleState: "running" });
    const refreshRegistration = vi.fn(async () => ({ ...current, pidAlive: false }));
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: {
        recoverRegisteredRunner,
      },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(refreshRegistration).toHaveBeenCalledOnce());
    expect(subject.logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() => expect(subject.markReaped).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recoverRegisteredRunner).toHaveBeenCalledTimes(2));
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();

    expect(refreshRegistration).toHaveBeenCalledOnce();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.invalidateRegistration).toHaveBeenCalledWith(
      current.config.paths,
      "registration-a",
    );
    expect(recoverRegisteredRunner).toHaveBeenNthCalledWith(
      2,
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      undefined,
    );
    expect(subject.markReaped.mock.invocationCallOrder[0]!).toBeLessThan(
      recoverRegisteredRunner.mock.invocationCallOrder[1]!,
    );
    expect(failedRunner.detachHost).toHaveBeenCalledOnce();
  });

  it("identity-fences and terminalizes a live registration whose socket disappeared", async () => {
    const socketError = runnerSocketMissingError();
    const failedRunner = failedRecoveryRunner();
    const recoverRegisteredRunner = vi.fn((
      recovered: Task,
      _config: unknown,
      _commandId: unknown,
      mode: string,
      onAttemptCreated?: (runner: NonNullable<Task["runner"]>) => void,
    ) => {
      if (mode === "offline") return Promise.resolve();
      const failure = Promise.reject(socketError);
      onAttemptCreated?.(failedRunner.runner);
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = failure;
      return failure;
    });
    const current = registration({ lifecycleState: "running" });
    const refreshRegistration = vi.fn(async () => current);
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: {
        recoverRegisteredRunner,
      },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(refreshRegistration).toHaveBeenCalledOnce());
    expect(subject.logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() => expect(subject.markReaped).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recoverRegisteredRunner).toHaveBeenCalledTimes(2));
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();

    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]!).toBeLessThan(
      subject.markReaped.mock.invocationCallOrder[0]!,
    );
    expect(subject.markReaped.mock.invocationCallOrder[0]!).toBeLessThan(
      recoverRegisteredRunner.mock.invocationCallOrder[1]!,
    );
  });

  it("does not kill a live prebootstrap runner for a transient missing socket", async () => {
    const socketError = runnerSocketMissingError();
    const failedRunner = failedRecoveryRunner();
    const recoverRegisteredRunner = vi.fn((recovered: Task) => {
      const failure = Promise.reject(socketError);
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = failure;
      return failure;
    });
    const pending = {
      ...registration(),
      bootstrap: null,
      lifecycle: null,
    };
    const refreshRegistration = vi.fn(async () => pending);
    const subject = makeSubject([pending], RECOVERY_NOW_MS, [], {
      taskExecutor: {
        recoverRegisteredRunner,
      },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(refreshRegistration).toHaveBeenCalledOnce());

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markReaped).not.toHaveBeenCalled();
  });

  it("does not replace a runner after a newer execution takes task ownership", async () => {
    const failedRunner = failedRecoveryRunner();
    const newerRunner = failedRecoveryRunner();
    let rejectAdoption!: (error: unknown) => void;
    const adoptionFailure = new Promise<void>((_resolve, reject) => {
      rejectAdoption = reject;
    });
    const recoverRegisteredRunner = vi.fn((
      recovered: Task,
      _config: unknown,
      _commandId: unknown,
      _mode: string,
      onAttemptCreated?: (
        runner: NonNullable<Task["runner"]>,
      ) => (() => void) | undefined,
    ) => {
      const markReady = onAttemptCreated?.(failedRunner.runner);
      markReady?.();
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = adoptionFailure;
      return adoptionFailure;
    });
    const current = registration({ lifecycleState: "running" });
    const refreshRegistration = vi.fn(async () => current);
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: { recoverRegisteredRunner },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    const newerExecution = Promise.resolve();
    subject.task.runner = newerRunner.runner;
    subject.task.executionPromise = newerExecution;
    rejectAdoption(runnerSocketMissingError());
    await subject.coordinator.waitForSettled();

    expect(subject.task.runner).toBe(newerRunner.runner);
    expect(subject.task.executionPromise).toBe(newerExecution);
    expect(refreshRegistration).not.toHaveBeenCalled();
    expect(failedRunner.detachHost).toHaveBeenCalledOnce();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markReaped).not.toHaveBeenCalled();
  });

  it("keeps an unowned attempt host channel during generic stand-down without respawning", async () => {
    let nowMs = RECOVERY_NOW_MS;
    const current = registration({ lifecycleState: "running" });
    const failedRunner = failedRecoveryRunner();
    const recoverRegisteredRunner = vi.fn((
      _recovered: Task,
      _config: unknown,
      _commandId: unknown,
      mode: string,
      onAttemptCreated?: (runner: NonNullable<Task["runner"]>) => void,
    ) => {
      if (mode === "offline") return Promise.resolve();
      onAttemptCreated?.(failedRunner.runner);
      return Promise.reject(new Error("transient adoption failure"));
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      now: () => nowMs,
      taskExecutor: { recoverRegisteredRunner },
      refreshRegistration: vi.fn(async () => current),
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(recoverRegisteredRunner).toHaveBeenCalledTimes(1);
    expect(failedRunner.detachHost).not.toHaveBeenCalled();

    nowMs += 15_000;
    await subject.coordinator.scanOnce();
    expect(recoverRegisteredRunner).toHaveBeenCalledTimes(1);
    expect(failedRunner.detachHost).not.toHaveBeenCalled();
  });

  it("keeps an attached attempt during stand-down and detaches it once the runner dies", async () => {
    let nowMs = RECOVERY_NOW_MS;
    const current = registration({ lifecycleState: "running" });
    const failedRunner = failedRecoveryRunner();
    const recoverRegisteredRunner = vi.fn((
      recovered: Task,
      _config: unknown,
      _commandId: unknown,
      mode: string,
      onAttemptCreated?: (runner: NonNullable<Task["runner"]>) => void,
    ) => {
      if (mode === "offline") return Promise.resolve();
      onAttemptCreated?.(failedRunner.runner);
      recovered.runner = failedRunner.runner;
      return Promise.reject(new Error("transient adoption failure"));
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      now: () => nowMs,
      taskExecutor: { recoverRegisteredRunner },
      refreshRegistration: vi.fn(async () => current),
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(subject.task.runner).toBe(failedRunner.runner);
    expect(failedRunner.detachHost).not.toHaveBeenCalled();

    current.pidAlive = false;
    nowMs += 15_000;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.markReaped).toHaveBeenCalledOnce();
    expect(failedRunner.detachHost).toHaveBeenCalledOnce();
    expect(recoverRegisteredRunner).toHaveBeenLastCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      undefined,
    );
  });

  it("runner death while the server lives drains its terminal fact without replacement", async () => {
    const subject = makeSubject([registration({ pidAlive: false })]);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      undefined,
    );
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
  });

  it("runner death while the server was absent follows the same terminal-only startup path", async () => {
    const subject = makeSubject([registration({ pidAlive: false })]);

    await subject.coordinator.start();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());
    await subject.coordinator.stop();

    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
  });

  it("startup terminates a live failed runner before replaying its durable error offline", async () => {
    const subject = makeSubject([registration({
      lifecycleState: "failed",
      terminalError: { code: "execution_failed", message: "CLI exited 1" },
    })]);

    await subject.coordinator.start();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());
    await subject.coordinator.stop();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]!).toBeLessThan(
      subject.recoverRegisteredRunner.mock.invocationCallOrder[0]!,
    );
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
  });

  it("terminates a live completed runner and replays its durable tail offline", async () => {
    const subject = makeSubject([registration({ lifecycleState: "completed" })]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]!).toBeLessThan(
      subject.recoverRegisteredRunner.mock.invocationCallOrder[0]!,
    );
  });

  it("does not block later recovery scans while a live completed runner drains offline", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const recoverRegisteredRunner = recoveryMockWithReadiness(() => recovery);
    const subject = makeSubject([registration({ lifecycleState: "completed" })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner,
      },
    });

    await expect(Promise.race([
      subject.coordinator.scanOnce().then(() => "scanned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("scanned");
    expect(recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    expect(subject.terminate).toHaveBeenCalledOnce();

    let laterScanSettled = false;
    const laterScan = subject.coordinator.scanOnce().then(() => {
      laterScanSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const skippedWithoutWaiting = laterScanSettled;

    finishRecovery();
    await laterScan;
    await subject.coordinator.stop();
    expect(skippedWithoutWaiting).toBe(true);
  });

  it("does not terminate a live terminal registration already owned by this host", async () => {
    const subject = makeSubject([registration({ lifecycleState: "completed" })]);
    subject.task.runner = {} as NonNullable<Task["runner"]>;

    await subject.coordinator.scanOnce();

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("replays a durable terminal state offline when the child exited before host recovery", async () => {
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledWith(
      expect.anything(),
      "registration-a",
    );
  });

  it("replays and logs a dead terminal registration only once after retirement", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    const retireTerminalRegistration = vi.fn(async () => {
      current.retiredAt = new Date(RECOVERY_NOW_MS).toISOString();
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      spawner: {
        terminate: vi.fn(async () => "registration_invalidated" as const),
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration,
      },
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "replay_terminal_dead" }),
      "terminal runner with no live process replayed offline and retired",
    );
    expect(subject.logger.info.mock.calls.filter(
      ([, message]) => message
        === "terminal runner with no live process replayed offline and retired",
    )).toHaveLength(1);
  });

  it("retires an already-reaped registration after its terminal replay so the next scan does not replay", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "reaped" });
    const replay = vi.fn(async (recovered: Task) => {
      recovered.status = "completed";
      recovered.terminationReason = "completed_ok";
      recovered.terminationEventRecorded = true;
      recovered.terminalEventId = 3;
    });
    const retireTerminalRegistration = vi.fn(async () => {
      current.retiredAt = new Date(RECOVERY_NOW_MS).toISOString();
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: { recoverRegisteredRunner: replay },
      spawner: {
        terminate: vi.fn(async () => "registration_invalidated" as const),
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(replay).toHaveBeenCalledOnce();
    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(current.retiredAt).toBeTruthy();

    await subject.coordinator.scanOnce();

    expect(replay).toHaveBeenCalledOnce();
    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
  });

  it("retires a dead running registration after its terminal replay so the next scan does not repeat the reap", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "running" });
    const replay = vi.fn(async (recovered: Task) => {
      recovered.status = "completed";
      recovered.terminationReason = "completed_ok";
      recovered.terminationEventRecorded = true;
      recovered.terminalEventId = 3;
    });
    const retireTerminalRegistration = vi.fn(async () => {
      current.retiredAt = new Date(RECOVERY_NOW_MS).toISOString();
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: { recoverRegisteredRunner: replay },
      spawner: {
        terminate: vi.fn(async () => "registration_invalidated" as const),
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(replay).toHaveBeenCalledOnce();
    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(current.retiredAt).toBeTruthy();

    await subject.coordinator.scanOnce();

    expect(replay).toHaveBeenCalledOnce();
    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
  });

  it("keeps an already-reaped registration when its offline replay records no session terminal", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "reaped" });
    const replay = vi.fn(async () => {});
    const retireTerminalRegistration = vi.fn(async () => {
      current.retiredAt = new Date(RECOVERY_NOW_MS).toISOString();
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: { recoverRegisteredRunner: replay },
      spawner: {
        terminate: vi.fn(async () => "registration_invalidated" as const),
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(retireTerminalRegistration).not.toHaveBeenCalled();
    expect(current.retiredAt).toBeUndefined();
  });

  it("keeps an already-reaped registration when its offline replay fails", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "reaped" });
    const replay = vi.fn(async () => {
      throw new Error("offline replay failed");
    });
    const retireTerminalRegistration = vi.fn(async () => {
      current.retiredAt = new Date(RECOVERY_NOW_MS).toISOString();
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: { recoverRegisteredRunner: replay },
      spawner: {
        terminate: vi.fn(async () => "registration_invalidated" as const),
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration,
      } as never,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(retireTerminalRegistration).not.toHaveBeenCalled();
    expect(current.retiredAt).toBeUndefined();
  });

  it("retires kernel-free runner evidence whose central session was deleted", async () => {
    const current = registration({
      pidAlive: false,
      lifecycleState: "running",
    });
    current.pid = null;
    current.pidStartIdentity = null;
    const retireReleased = vi.fn(async (
      _paths: unknown,
      _expected: unknown,
      _registration: RunnerRegistration,
      confirmRetirementStillValid: () => Promise<boolean>,
    ) => {
      expect(await confirmRetirementStillValid()).toBe(true);
      current.retiredAt = new Date(RECOVERY_NOW_MS).toISOString();
      return "registration_absent" as const;
    });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => null),
      } as never,
      spawner: {
        terminate: retireReleased,
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration: vi.fn(async () => {}),
      },
    });

    await subject.coordinator.scanOnce();

    expect(retireReleased).toHaveBeenCalledOnce();
    expect(current.retiredAt).toBeTruthy();
    expect(subject.logger.warn).not.toHaveBeenCalled();
  });

  it("retires a recorded terminal registration before replay can duplicate session_ended", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    const retireTerminalRegistration = vi.fn(async () => {});
    const drain = vi.fn(async () => {});
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      closedTailDrainer: { drain },
      spawner: {
        terminate: vi.fn(async () => "registration_invalidated" as const),
        invalidateRegistration: vi.fn(async () => {}),
        retireTerminalRegistration,
      } as never,
    });
    subject.task.status = "error";
    subject.task.terminationReason = "error_aborted";
    subject.task.terminationDetail = "event outbox acknowledgement timed out";
    subject.task.terminationEventRecorded = true;
    subject.task.terminalEventId = 3;
    subject.task.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    expect(retireTerminalRegistration).toHaveBeenCalledWith(
      current.config.paths,
      "registration-a",
    );
  });

  it("drains an unacknowledged runner tail before retiring a recorded terminal registration", async () => {
    const current = registration({ pidAlive: true, lifecycleState: "closed" });
    current.closedTailState = {
      status: "requires_drain",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 3,
      acknowledgedThrough: 2,
    };
    const draining = deferred<void>();
    const drain = vi.fn(() => draining.promise);
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      closedTailDrainer: { drain },
    });
    recordTerminalCompletion(subject.task);

    const scan = subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(subject.terminate).toHaveBeenCalledWith(
      current.config.paths,
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]!).toBeLessThan(
      drain.mock.invocationCallOrder[0]!,
    );
    expect(drain).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "registration-a", pidAlive: false }),
      expect.anything(),
    );
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();

    draining.resolve();
    await scan;
    await subject.coordinator.waitForSettled();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledWith(
      current.config.paths,
      "registration-a",
    );
  });

  it("retires without draining when the same runner stream is already registered", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "closed" });
    current.closedTailState = {
      status: "requires_drain", streamId: "stream-session-a", sessionId: "session-a",
      latestDurableSourceSeq: 3, acknowledgedThrough: 2,
    };
    const drain = vi.fn(async () => {});
    const hasActivePump = vi.fn((streamId: string) => streamId === "stream-session-a");
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      closedTailDrainer: { drain, hasActivePump },
    });
    recordTerminalCompletion(subject.task);
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(hasActivePump).toHaveBeenCalledWith("stream-session-a");
    expect(drain).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
  });

  it("retires a recorded closed registration with a fully acknowledged tail without draining", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "closed" });
    current.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    const drain = vi.fn(async () => {});
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      closedTailDrainer: { drain },
    });
    recordTerminalCompletion(subject.task);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(drain).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
  });

  it("retries a failed closed tail drain before retiring a recorded terminal registration", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "closed" });
    current.closedTailState = {
      status: "requires_drain",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 3,
      acknowledgedThrough: 2,
    };
    const drain = vi.fn(async () => {}).mockRejectedValueOnce(new Error("ACK timed out"));
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      closedTailDrainer: { drain },
    });
    recordTerminalCompletion(subject.task);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(drain).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: "ACK timed out" }) }),
      "runner recovery action failed",
    );

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
  });

  it("retires the measured released sidecar shape without trusting stale lifecycle pid", async () => {
    const fixture = await releasedTerminalSidecarFixture();
    try {
      const subject = makeSubject([fixture.registration], RECOVERY_NOW_MS, [], {
        spawner: fixture.spawner,
      });
      recordTerminalCompletion(subject.task);

      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();

      const retiredIdentity = await readRunnerRegistrationIdentity(
        fixture.paths.sessionDirectory,
      );
      const recoveryFailures = subject.logger.error.mock.calls.filter(
        ([, message]) => message === "runner recovery action failed",
      );
      const retirementMarkers = subject.logger.info.mock.calls.filter(
        ([, message]) => message === "recorded terminal runner registration retired without replay",
      );
      const violations = [
        ...(fixture.registration.pid === fixture.staleLifecyclePid
          ? [] : ["reader_did_not_derive_stale_lifecycle_pid"]),
        ...(!fixture.registration.pidAlive ? [] : ["reader_marked_stale_pid_live"]),
        ...(fixture.registration.pidStartIdentity === null
          ? [] : ["reader_restored_start_identity"]),
        ...(!retiredIdentity?.retiredAt ? ["released_sidecar_not_retired"] : []),
        ...(retiredIdentity?.registrationId === fixture.registration.registrationId
          ? [] : ["registration_target_changed"]),
        ...(retiredIdentity?.pid === null && retiredIdentity.startIdentity === null
          ? [] : ["released_process_identity_restored"]),
        ...(await pathExists(fixture.paths.pidPath) ? ["runner_pid_evidence_remains"] : []),
        ...(await pathExists(fixture.paths.lockPath) ? ["writer_lock_remains"] : []),
        ...recoveryFailures.map(() => "released_terminal_retried"),
        ...(retirementMarkers.length === 1 ? [] : ["released_retirement_marker_missing"]),
        ...(fixture.registration.lifecycle?.runner_pid === fixture.staleLifecyclePid
          ? [] : ["stale_lifecycle_pid_fixture_lost"]),
      ];
      expect(violations).toEqual([]);
      expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retires exact live or residual registration identity after terminal event", async () => {
    const livePid = await releasedTerminalSidecarFixture({
      lifecyclePid: process.pid,
      identityPid: process.pid,
      identityStartIdentity: "live-process-start",
    });
    const residualStartIdentity = await releasedTerminalSidecarFixture({
      lifecyclePid: 880_010,
      identityPid: 880_010,
      identityStartIdentity: "dead-process-start",
    });
    const controls = [
      ["live_pid", livePid],
      ["residual_start_identity", residualStartIdentity],
    ] as const;
    const violations: string[] = [];

    try {
      for (const [label, fixture] of controls) {
        const subject = makeSubject([fixture.registration], RECOVERY_NOW_MS, [], {
          spawner: fixture.spawner,
        });
        recordTerminalCompletion(subject.task);
        await subject.coordinator.scanOnce();
        await subject.coordinator.waitForSettled();
        const failures = subject.logger.error.mock.calls.filter(
          ([, message]) => message === "runner recovery action failed",
        );
        const identity = await readRunnerRegistrationIdentity(fixture.paths.sessionDirectory);
        if (failures.length !== 0) violations.push(`${label}_recovery_failed`);
        if (subject.terminate.mock.calls.length !== 0) violations.push(`${label}_terminated`);
        if (identity && !identity.retiredAt) violations.push(`${label}_registration_not_retired`);
      }
    } finally {
      await Promise.all(controls.map(async ([, fixture]) =>
        await rm(fixture.root, { recursive: true, force: true })));
    }

    expect(violations).toEqual([]);
  });

  it("fails closed when process identity reappears before released retirement", async () => {
    const fixture = await releasedTerminalSidecarFixture();
    await writeRunnerRegistrationIdentity(fixture.paths.sessionDirectory, {
      schemaVersion: 1,
      registrationId: fixture.registration.registrationId!,
      sessionId: fixture.registration.config.sessionId,
      codeSha: fixture.registration.config.codeSha,
      releaseManifestId: "sha256-d8dc3e37",
      runtimeEnvIdentity: "sha256-51ae3e79",
      pid: 880_001,
      startIdentity: "start-880001",
    });
    try {
      const subject = makeSubject([fixture.registration], RECOVERY_NOW_MS, [], {
        spawner: fixture.spawner,
      });
      recordTerminalCompletion(subject.task);

      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();

      const identity = await readRunnerRegistrationIdentity(fixture.paths.sessionDirectory);
      expect(identity?.retiredAt).toBeUndefined();
      expect(identity).toMatchObject({ pid: 880_001, startIdentity: "start-880001" });
      expect(subject.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "runner recovery action failed",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not block server startup on a dead terminal runner waiting for upstream ACK", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const recoverRegisteredRunner = recoveryMockWithReadiness(() => recovery);
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner,
      },
    });

    await expect(Promise.race([
      subject.coordinator.scanOnce().then(() => "scanned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("scanned");
    expect(recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    finishRecovery();
    await subject.coordinator.stop();
  });

  it("does not await runner session garbage collection during startup", async () => {
    let finishCollection!: () => void;
    const collection = new Promise<{ removed: string[]; retained: [] }>((resolve) => {
      finishCollection = () => resolve({ removed: [], retained: [] });
    });
    const sessionGarbageCollector = { collect: vi.fn(() => collection) };
    const retired = registration({ pidAlive: false, lifecycleState: "completed" });
    retired.retiredAt = "2026-08-11T00:00:25.000Z";
    const subject = makeSubject(
      [retired],
      Date.parse("2026-08-11T00:00:30.000Z"),
      [],
      { sessionGarbageCollector },
    );

    await expect(Promise.race([
      subject.coordinator.start().then(() => "started"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("started");
    expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce();

    finishCollection();
    await subject.coordinator.stop();
  });

  it("scans during central lookup and waits only while a session directory is removed", async () => {
    const lookupStarted = deferred<void>();
    const finishLookup = deferred<void>();
    const removalStarted = deferred<void>();
    const finishRemoval = deferred<void>();
    const phases: string[] = [];
    const retired = registration({ pidAlive: false, lifecycleState: "completed" });
    retired.retiredAt = "2026-08-01T00:00:00.000Z";
    let lookupCount = 0;
    const sessionGarbageCollector = new RunnerSessionGarbageCollector(
      "/runner", 1_000, { info: vi.fn(), warn: vi.fn() }, {
        now: () => RECOVERY_NOW_MS,
        monotonicNow: () => 0,
        withMutationLock: async (_path, operation) => await operation(),
        refresh: async (item) => item,
        probeRetention: async (item) => ({ registration: item, localRetentionReason: null }),
        inspect: async (item) => ({
          registration: item, acknowledgedThrough: 1, latestDurableSourceSeq: 1,
          incompleteDurableWork: false, durableRecordCount: 1, unacknowledgedIpcFrameCount: 0,
        }),
        moveDirectory: async () => { removalStarted.resolve(); await finishRemoval.promise; },
        listTrash: async () => [],
        removeDirectory: async () => {},
      },
    );
    const scan = vi.fn(async () => ({ registrations: [retired], errors: [] }));
    const subject = makeSubject(
      [retired],
      RECOVERY_NOW_MS,
      [],
      {
        sessionGarbageCollector,
        scan,
        nodeStallMonitor: {
          beginRunnerOperation: (context) => {
            if (context.phase) phases.push(context.phase);
            return () => {};
          },
        },
        taskManager: {
          listExistingSessionIds: async () => {
            lookupCount++;
            if (lookupCount === 1) { lookupStarted.resolve(); await finishLookup.promise; }
            return [];
          },
        } as never,
      },
    );

    await subject.coordinator.scanOnce();
    await lookupStarted.promise;
    const duringLookup = subject.coordinator.scanOnce().then(() => "scanned");
    const lookupResult = await Promise.race([
      duringLookup,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    finishLookup.resolve();
    await removalStarted.promise;
    if (lookupResult === "blocked") {
      finishRemoval.resolve();
      await duringLookup;
      await subject.coordinator.stop();
      expect(lookupResult).toBe("scanned");
      return;
    }
    await duringLookup;
    const scansBeforeRemoval = scan.mock.calls.length;
    phases.length = 0;
    const laterScan = subject.coordinator.scanOnce().then(() => "scanned");
    const removalResult = await Promise.race([
      laterScan,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    const scansDuringRemoval = scan.mock.calls.length;
    const phasesDuringRemoval = [...phases];
    finishRemoval.resolve();
    await expect(laterScan).resolves.toBe("scanned");
    expect(removalResult).toBe("blocked");
    expect(scansDuringRemoval).toBe(scansBeforeRemoval);
    expect(phasesDuringRemoval).toContain("gcWait");
    expect(scan).toHaveBeenCalledTimes(scansBeforeRemoval + 1);
    await subject.coordinator.stop();
  });

  it("does not wait for trash removal outside the gate during a recovery scan", async () => {
    const removalStarted = deferred<void>();
    const finishRemoval = deferred<void>();
    const phases: string[] = [];
    const retired = registration({ pidAlive: false, lifecycleState: "completed" });
    retired.retiredAt = "2026-08-01T00:00:00.000Z";
    const sessionGarbageCollector = new RunnerSessionGarbageCollector(
      "/runner", 1_000, { info: vi.fn(), warn: vi.fn() }, {
        now: () => RECOVERY_NOW_MS, monotonicNow: () => 0,
        withMutationLock: async (_path, operation) => await operation(),
        refresh: async (item) => item,
        probeRetention: async (item) => ({ registration: item, localRetentionReason: null }),
        inspect: async (item) => ({ registration: item, acknowledgedThrough: 1, latestDurableSourceSeq: 1,
          incompleteDurableWork: false, durableRecordCount: 1, unacknowledgedIpcFrameCount: 0 }),
        moveDirectory: async () => {}, listTrash: async () => ["old"],
        removeDirectory: async () => { removalStarted.resolve(); await finishRemoval.promise; },
      },
    );
    const subject = makeSubject([retired], RECOVERY_NOW_MS, [], {
      sessionGarbageCollector,
      nodeStallMonitor: { beginRunnerOperation: (context) => { if (context.phase) phases.push(context.phase); return () => {}; } },
    });
    await subject.coordinator.scanOnce();
    await removalStarted.promise;
    phases.length = 0;
    const scan = subject.coordinator.scanOnce();
    const outcome = await Promise.race([scan.then(() => "scanned"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 50))]);
    finishRemoval.resolve();
    await scan;
    await subject.coordinator.stop();
    expect(outcome).toBe("scanned");
    // gcWait is observed even when no removal is in flight; completion before
    // finishRemoval proves that the synchronous observation did not wait.
    expect(phases).toContain("gcWait");
  });

  it("keeps terminal replay ahead of session garbage collection", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const current = registration({
      pidAlive: false,
      lifecycleState: "completed",
    });
    const sessionGarbageCollector = {
      collect: vi.fn<RunnerSessionGarbageCollector["collect"]>(async () => ({ removed: [], retained: [] })),
    };
    const subject = makeSubject([current], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner: recoveryMockWithReadiness(() => recovery),
      },
      sessionGarbageCollector,
    });

    await subject.coordinator.scanOnce();

    expect(sessionGarbageCollector.collect).not.toHaveBeenCalled();
    finishRecovery();
    await subject.coordinator.waitForSettled();
    current.retiredAt = new Date().toISOString();
    await subject.coordinator.scanOnce();
    expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce();
    await subject.coordinator.stop();
  });

  it("adopts a live exact runner despite stale progress age", async () => {
    const subject = makeSubject([registration({
      progressedAt: "2026-08-11T00:00:00.000Z",
    })], Date.parse("2026-08-11T00:11:00.000Z"));

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.objectContaining({
        registrationId: "registration-a",
        pid: 4123,
        pidStartIdentity: "start-4123",
        pidAlive: true,
      }),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markReaped).not.toHaveBeenCalled();
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
  });

  it("terminates and drains offline when reap verification discovers a live completed runner", async () => {
    const scanned = registration({ pidAlive: false, lifecycleState: "running" });
    const terminal = registration({ lifecycleState: "completed" });
    const subject = makeSubject(
      [scanned],
      RECOVERY_NOW_MS,
      [],
      { hydrate: async () => terminal },
    );

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.terminate).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    expect(subject.markReaped).not.toHaveBeenCalled();
  });

  it("drains a previously reaped registration without replacement", async () => {
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "reaped",
      terminalError: { code: "lease_expired", message: "lease expired before restart" },
    })]);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "offline",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
    );
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
    expect(subject.task.runnerTerminalFact).toBe("reaped");
  });

  it("conservatively drains a closed registration across restarts when tail state is missing", async () => {
    const closed = registration({
      pidAlive: false,
      lifecycleState: "closed",
    });
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const sessionEnded = vi.fn();
    const delivery = vi.fn();
    const callerNotification = vi.fn();
    const recoverRegisteredRunner = vi.fn(async () => {
      sessionEnded();
      delivery();
      callerNotification();
    });
    const taskExecutor = {
      recoverRegisteredRunner,
    };
    const first = makeSubject([closed], Date.now(), [], { closedTailDrainer, taskExecutor });
    const second = makeSubject([closed], Date.now(), [], { closedTailDrainer, taskExecutor });

    await first.coordinator.scanOnce();
    await second.coordinator.scanOnce();
    await first.coordinator.waitForSettled();
    await second.coordinator.waitForSettled();

    expect(closedTailDrainer.drain).toHaveBeenCalledTimes(2);
    expect(first.hydrateRunnerRecoveryTask).toHaveBeenCalledOnce();
    expect(second.hydrateRunnerRecoveryTask).toHaveBeenCalledOnce();
    expect(first.projectClosedRunner).toHaveBeenCalledOnce();
    expect(second.projectClosedRunner).toHaveBeenCalledOnce();
    expect(first.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(second.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(first.markRunnerFailure).not.toHaveBeenCalled();
    expect(second.markRunnerFailure).not.toHaveBeenCalled();
    expect(sessionEnded).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(callerNotification).not.toHaveBeenCalled();
  });

  it("reclassifies a closed admission after hydration instead of terminating its replacement", async () => {
    const admittedClosed = registration({ pidAlive: false, lifecycleState: "closed" });
    const replacement = registration({ pidAlive: true, lifecycleState: "running" });
    const subject = makeSubject([admittedClosed], Date.now(), [], {
      hydrate: vi.fn(async () => replacement),
    });
    subject.task.runner = {
      dispatcher: {} as NonNullable<Task["runner"]>["dispatcher"],
      engine: {} as NonNullable<Task["runner"]>["engine"],
      eventPersistence: "runner",
    };

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.projectClosedRunner).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.task.runner).toBeDefined();
  });

  it("does not terminalize a closed old identity while the task holds a newer execution", async () => {
    const admitted = registration({ pidAlive: false, lifecycleState: "closed" });
    const hydrated = { ...admitted, pidAlive: true };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([admitted], Date.now(), [], {
      hydrate: vi.fn(async () => hydrated),
      closedTailDrainer,
    });
    subject.task.executionPromise = Promise.resolve();
    subject.task.runner = {
      dispatcher: {
        hasActiveExecution: () => true,
        registrationId: () => "replacement-registration",
      } as never,
    } as never;

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.projectClosedRunner).not.toHaveBeenCalled();
    expect(closedTailDrainer.drain).not.toHaveBeenCalled();
  });

  it.each(["running", "completed"] as const)("classifies a missing terminal after retirement while task is %s", async (status) => {
    const admitted = registration({ pidAlive: false, lifecycleState: "reaped" });
    const subject = makeSubject([admitted]);
    const execution = deferred<void>();
    subject.task.status = "running";
    subject.task.executionPromise = execution.promise;
    const retireTerminalRegistration = vi.fn(async (before?: () => Promise<void>) => {
      subject.task.status = status;
      subject.task.executionPromise = undefined;
      execution.resolve();
      await before?.();
    });
    subject.task.runner = { dispatcher: {
      registrationId: () => admitted.registrationId, activeExecutionCommandId: () => "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      hasActiveExecution: () => true, retireTerminalRegistration,
    } } as never;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.task.runner).toBeDefined();
    if (status === "running") {
      expect(subject.logger.info).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-a" }), "runner recovery action deferred: successor turn started");
      expect(subject.logger.error).not.toHaveBeenCalled();
    } else {
      expect(subject.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: expect.stringContaining("did not record session terminal") }) }), "runner recovery action failed");
    }
  });

  it("retires an attached reaped admission with the matching command before invalidation", async () => {
    const admitted = registration({ pidAlive: false, lifecycleState: "reaped" });
    const subject = makeSubject([admitted]);
    const execution = deferred<void>();
    const order: string[] = [];
    subject.task.status = "running";
    subject.task.executionPromise = execution.promise;
    const retireTerminalRegistration = vi.fn(async (before?: () => Promise<void>) => {
      order.push("retire");
      subject.task.status = "error";
      subject.task.terminationEventRecorded = true;
      subject.task.terminalEventId = 15;
      subject.task.executionPromise = undefined;
      execution.resolve();
      await before?.();
    });
    subject.task.runner = {
      dispatcher: {
        registrationId: () => admitted.registrationId,
        activeExecutionCommandId: () => "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        hasActiveExecution: () => true,
        retireTerminalRegistration,
      } as never,
    } as never;
    subject.invalidateRegistration.mockImplementation(async () => {
      order.push("invalidate");
    });
    subject.terminate.mockImplementation(async () => {
      order.push("terminate");
      return "registration_invalidated" as const;
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(order).toEqual(["retire"]);
    expect(subject.invalidateRegistration).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.task.executionPromise).toBeUndefined();
    expect(subject.task.runner).toBeUndefined();
    expect(subject.task.status).toBe("error");
  });

  it("skips recovery if a runner attaches while registration hydrates", async () => {
    const admitted = registration();
    let subject!: ReturnType<typeof makeSubject>;
    subject = makeSubject([admitted], undefined, [], {
      hydrate: async (value) => {
        subject.task.runner = { dispatcher: {} } as never;
        return value;
      },
    });
    const result = await (subject.coordinator as unknown as {
      recoverRegistered: (registration: RunnerRegistration, task: Task, mode: "replay") => Promise<{ replayed: boolean }>;
    }).recoverRegistered(admitted, subject.task, "replay");

    expect(result.replayed).toBe(false);
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "replay", blockedBy: "runner" }),
      "registered runner recovery skipped because the task still holds an execution",
    );
    expect(subject.logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "registered runner recovery skipped because the task still holds an execution",
    );
  });

  it("leaves a mismatched attached command for offline recovery to report blockedBy runner", async () => {
    const admitted = registration({ pidAlive: false, lifecycleState: "reaped" });
    const subject = makeSubject([admitted]);
    const retireTerminalRegistration = vi.fn(async () => {});
    subject.task.status = "running";
    subject.task.executionPromise = Promise.resolve();
    subject.task.runner = {
      dispatcher: {
        registrationId: () => admitted.registrationId,
        activeExecutionCommandId: () => "execute:33333333-3333-4333-8333-333333333333:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        hasActiveExecution: () => true,
        retireTerminalRegistration,
      } as never,
    } as never;

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.invalidateRegistration).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.task.runner).toBeDefined();
    expect(subject.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "offline",
        blockedBy: "runner",
        taskStatus: "running",
      }),
      "registered runner recovery skipped because the task still holds an execution",
    );
  });

  it("applies the held-execution guard before retiring a pidAlive reaped registration", async () => {
    const admitted = registration({ pidAlive: true, lifecycleState: "reaped" });
    const subject = makeSubject([admitted]);
    const retireTerminalRegistration = vi.fn(async () => {});
    subject.task.status = "running";
    subject.task.executionPromise = Promise.resolve();
    subject.task.runner = {
      dispatcher: {
        registrationId: () => admitted.registrationId,
        activeExecutionCommandId: () => undefined,
        hasActiveExecution: () => false,
        retireTerminalRegistration,
      } as never,
    } as never;

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.invalidateRegistration).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it.each([
    ["running", false],
    ["running", true],
    ["completed", false],
    ["completed", true],
    ["error", false],
    ["error", true],
    ["interrupted", false],
    ["interrupted", true],
  ] as const)(
    "projects a closed runner for central %s with tail=%s",
    async (centralStatus, tailRequiresDrain) => {
      const closed = registration({ pidAlive: false, lifecycleState: "closed" });
      closed.closedTailState = tailRequiresDrain
        ? {
            status: "requires_drain",
            streamId: "stream-session-a",
            sessionId: "session-a",
            latestDurableSourceSeq: 3,
            acknowledgedThrough: 2,
          }
        : {
            status: "fully_acknowledged",
            streamId: "stream-session-a",
            sessionId: "session-a",
            latestDurableSourceSeq: 2,
            acknowledgedThrough: 2,
          };
      const closedTailDrainer = { drain: vi.fn(async () => {}) };
      const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });
      subject.task.status = centralStatus;

      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();

      expect(closedTailDrainer.drain).toHaveBeenCalledTimes(
        tailRequiresDrain ? 1 : 0,
      );
      expect(subject.projectClosedRunner).toHaveBeenCalledWith(
        subject.task,
        "runner lifecycle closed during startup recovery",
      );
    },
  );

  it("does not open a fully acknowledged closed registration across repeated scans", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).not.toHaveBeenCalled();
  });

  it("never skips a closed registration with an unacknowledged durable tail", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "requires_drain",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 3,
      acknowledgedThrough: 2,
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledOnce();
  });

  it("rechecks a closed registration when a new event advances its durable head", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();
    closed.closedTailState = {
      status: "requires_drain",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 3,
      acknowledgedThrough: 2,
    };
    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledOnce();
  });

  it("conservatively drains when the closed-tail fingerprint cannot be trusted", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "unknown",
      reason: "runner host checkpoint hash mismatch",
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledOnce();
  });

  it("logs recovery scan duration and closed-tail decisions at info", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    let now = 100;
    const monotonicNow = () => now;
    const subject = makeSubject([closed], Date.now(), [], {
      monotonicNow,
      scan: async () => {
        now = 112.5;
        return { registrations: [closed], errors: [] };
      },
    });

    await subject.coordinator.scanOnce();

    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 12.5,
        terminalRegistrations: 1,
        closedRegistrations: 1,
        closedTailDrains: 0,
        closedTailSkips: 1,
      }),
      "runner recovery scan completed",
    );
  });

  it("coalesces overlapping scan requests into one filesystem scan", async () => {
    let releaseScan!: () => void;
    const gate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const scan = vi.fn(async () => {
      await gate;
      return { registrations: [], errors: [] };
    });
    const subject = makeSubject([], Date.now(), [], { scan });
    await subject.coordinator.restoreScanCache();

    const first = subject.coordinator.scanOnce();
    const second = subject.coordinator.scanOnce();
    expect(scan).toHaveBeenCalledOnce();
    releaseScan();
    await Promise.all([first, second]);
  });

  it("a reboot scan independently drains every dead registration without replacement", async () => {
    const first = registration({ sessionId: "session-a", pidAlive: false });
    const second = registration({ sessionId: "session-b", pidAlive: false });
    const subject = makeSubject([first, second]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledTimes(2));

    expect(subject.hydrateRunnerRecoveryTask).toHaveBeenCalledWith("session-a");
    expect(subject.hydrateRunnerRecoveryTask).toHaveBeenCalledWith("session-b");
  });

  it("hydrates every admitted task before starting any recovery execution", async () => {
    const order: string[] = [];
    const first = registration({ sessionId: "session-a" });
    const second = registration({ sessionId: "session-b" });
    const tasks = new Map([
      ["session-a", task("session-a")],
      ["session-b", task("session-b")],
    ]);
    const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) => {
      order.push(`hydrate:${sessionId}`);
      return tasks.get(sessionId) ?? null;
    });
    const recoverRegisteredRunner = vi.fn(async (recovered: Task) => {
      order.push(`recover:${recovered.agentSessionId}`);
    });
    const subject = makeSubject([first, second], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
      },
      taskExecutor: {
        recoverRegisteredRunner,
      },
    });

    await subject.coordinator.scanOnce();

    expect(order).toEqual([
      "hydrate:session-a",
      "hydrate:session-b",
      "recover:session-a",
      "recover:session-b",
    ]);
  });

  it("caps the default hydration phase at ten seconds and defers unresolved work", async () => {
    let finishHydration!: (value: Task) => void;
    const hydration = new Promise<Task>((resolve) => { finishHydration = resolve; });
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(() => hydration),
      },
    });
    await subject.coordinator.restoreScanCache();
    vi.useFakeTimers();
    let scanFinished = false;
    const scan = subject.coordinator.scanOnce().then(() => { scanFinished = true; });
    let beforeDeadline = false;
    let atDeadline = false;

    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9_999);
      beforeDeadline = scanFinished;
      await vi.advanceTimersByTimeAsync(1);
      atDeadline = scanFinished;
    } finally {
      finishHydration(task("session-a"));
      await scan;
      vi.useRealTimers();
    }

    expect(beforeDeadline).toBe(false);
    expect(atDeadline).toBe(true);
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("starts at most four hydrations and leaves the queued remainder for a later scan", async () => {
    const registrations = Array.from({ length: 6 }, (_, index) =>
      registration({ sessionId: `session-${index}` }));
    const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return task(sessionId);
    });
    const subject = makeSubject(registrations, RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
      },
    });
    await subject.coordinator.restoreScanCache();
    vi.useFakeTimers();

    let scanFinished = false;
    const scan = subject.coordinator.scanOnce().then(() => { scanFinished = true; });
    let callsAtDeadline = 0;
    let finishedAtDeadline = false;
    let callsOnSecondScan = 0;
    let recoveriesOnSecondScan = 0;
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      callsAtDeadline = hydrateRunnerRecoveryTask.mock.calls.length;
      finishedAtDeadline = scanFinished;
      await vi.advanceTimersByTimeAsync(120_000);
      await scan;
      const secondScan = subject.coordinator.scanOnce();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await secondScan;
      callsOnSecondScan = hydrateRunnerRecoveryTask.mock.calls.length;
      recoveriesOnSecondScan = subject.recoverRegisteredRunner.mock.calls.length;
    } finally {
      vi.useRealTimers();
    }

    expect(finishedAtDeadline).toBe(true);
    expect(callsAtDeadline).toBe(4);
    expect(callsOnSecondScan).toBe(6);
    expect(recoveriesOnSecondScan).toBe(4);
  });

  it("reuses an in-flight hydration result on the next scan instead of duplicating the host call", async () => {
    let finishHydration!: (value: Task) => void;
    const hydration = new Promise<Task>((resolve) => { finishHydration = resolve; });
    const hydrateRunnerRecoveryTask = vi.fn(() => hydration);
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
      },
    });
    await subject.coordinator.restoreScanCache();
    vi.useFakeTimers();
    let firstFinished = false;
    const firstScan = subject.coordinator.scanOnce().then(() => { firstFinished = true; });
    let finishedAtDeadline = false;
    let recoveredBeforeSecondScan = -1;

    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      finishedAtDeadline = firstFinished;
      finishHydration(task("session-a"));
      if (!firstFinished) await firstScan;
      await Promise.resolve();
      recoveredBeforeSecondScan = subject.recoverRegisteredRunner.mock.calls.length;
      if (finishedAtDeadline) await subject.coordinator.scanOnce();
    } finally {
      vi.useRealTimers();
    }

    expect(finishedAtDeadline).toBe(true);
    expect(recoveredBeforeSecondScan).toBe(0);
    expect(hydrateRunnerRecoveryTask).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
  });

  it("executes ready recoveries while a retryable host hydration failure stays deferred", async () => {
    const transient = new TaskHydrationFailedError(
      "session-a",
      new SessionDataHostError({
        operation: "get",
        retryable: true,
        message: "session-data host get failed",
      }),
    );
    const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-a") throw transient;
      return task(sessionId);
    });
    const subject = makeSubject([
      registration({ sessionId: "session-a" }),
      registration({ sessionId: "session-b" }),
    ], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
      },
    });

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-b" }),
      expect.anything(),
      "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "adopt",
      expect.any(Function),
      expect.objectContaining({
        runSync: expect.any(Function),
        runAsync: expect.any(Function),
        databaseSummary: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(subject.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: transient,
        sessionId: "session-a",
        disposition: "adopt_running",
      }),
      "runner recovery hydration deferred",
    );
    expect(subject.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "runner recovery action failed",
    );
  });

  it("periodically re-emits repeated hydration deferral without log flooding", async () => {
    let now = RECOVERY_NOW_MS;
    const transient = new TaskHydrationFailedError(
      "session-a",
      new SessionDataHostError({
        operation: "get",
        retryable: true,
        message: "session-data host get failed",
      }),
    );
    const hydrateRunnerRecoveryTask = vi.fn(async () => { throw transient; });
    const subject = makeSubject([registration()], now, [], {
      now: () => now,
      leaseTimeoutMs: 2 * 60 * 60 * 1_000,
      taskManager: {
        hydrateRunnerRecoveryTask,
      },
    });

    await subject.coordinator.scanOnce();
    now += 15_000;
    await subject.coordinator.scanOnce();
    now += 14 * 60 * 1_000 + 45_000;
    await subject.coordinator.scanOnce();

    const deferredWarnings = subject.logger.warn.mock.calls.filter(
      ([, message]) => message === "runner recovery hydration deferred",
    );
    expect(deferredWarnings).toHaveLength(2);
    expect(deferredWarnings[1]).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        disposition: "adopt_running",
        suppressedSince: "2026-08-11T00:00:45.000Z",
        suppressedCount: 1,
      }),
      "runner recovery hydration deferred",
    ]);
  });

  it("disk or registration read failure is loud and does not invent recovery state", async () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const subject = makeSubject([], Date.now(), [{ directory: "/runner/a", error }]);

    await subject.coordinator.scanOnce();

    expect(subject.logger.error).toHaveBeenCalledWith(
      { directory: "/runner/a", err: error },
      "runner registration is unreadable",
    );
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
  });

  it("logs an unreadable registration once until its error fingerprint changes", async () => {
    let failure = {
      directory: "/runner/a",
      error: new Error("internalMcpUrl is required"),
      sessionId: "session-a",
    };
    const scan = vi.fn(async () => ({ registrations: [], errors: [failure] }));
    const quarantineFailure = vi.fn(async () => ({
      status: "retained" as const,
      reason: "runner_alive" as const,
    }));
    const subject = makeSubject([], Date.now(), [], { scan, quarantineFailure });

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();
    failure = { ...failure, error: new Error("runner config JSON is damaged") };
    await subject.coordinator.scanOnce();

    expect(quarantineFailure).toHaveBeenCalledTimes(3);
    expect(subject.logger.error).toHaveBeenCalledTimes(2);
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      1,
      failureContext("internalMcpUrl is required"),
      "runner registration is unreadable",
    );
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      2,
      failureContext("runner config JSON is damaged"),
      "runner registration is unreadable",
    );
  });

  it("periodically re-emits a repeated recovery failure until its fingerprint changes", async () => {
    let now = Date.parse("2026-08-14T00:00:00.000Z");
    let failure = Object.assign(
      new Error("runner bootstrap record required before event append"),
      { code: "SQLITE_CORRUPT" },
    );
    const drain = vi.fn(async () => { throw failure; });
    const current = registration({ pidAlive: false, lifecycleState: "closed" });
    const subject = makeSubject([current], now, [], {
      closedTailDrainer: { drain },
      now: () => now,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    now += 15_000;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    now += 14 * 60 * 1_000 + 45_000;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    failure = Object.assign(new Error("runner host checkpoint is corrupt"), {
      code: "SQLITE_CORRUPT",
    });
    now += 1;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(drain).toHaveBeenCalledTimes(4);
    expect(subject.logger.error).toHaveBeenCalledTimes(3);
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        err: expect.objectContaining({
          message: "runner bootstrap record required before event append",
        }),
        sessionId: "session-a",
        disposition: "closed",
      }),
      "runner recovery action failed",
    );
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        suppressedSince: "2026-08-14T00:00:15.000Z",
        suppressedCount: 1,
        sessionId: "session-a",
        disposition: "closed",
      }),
      "runner recovery action failed",
    );
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        err: expect.objectContaining({ message: "runner host checkpoint is corrupt" }),
        sessionId: "session-a",
        disposition: "closed",
      }),
      "runner recovery action failed",
    );
  });

  it("retires a dead registration without lifecycle after marking failure and skips the next scan", async () => {
    const dead: RunnerRegistration = {
      ...registration({ pidAlive: false }), lifecycle: null, pid: null, pidStartIdentity: null,
    };
    const registrations = [dead];
    const subject = makeSubject(registrations, Date.now());
    subject.terminate.mockImplementation(async (_paths, _expected, released) => {
      expect(released).toMatchObject({ pid: null, pidAlive: false, pidStartIdentity: null });
      registrations[0] = { ...dead, retiredAt: new Date().toISOString() };
      return "registration_invalidated" as const;
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.markRunnerFailure).toHaveBeenCalledOnce();
    expect(subject.terminate).toHaveBeenCalledOnce();
    expect(subject.markRunnerFailure.mock.invocationCallOrder[0]!)
      .toBeLessThan(subject.terminate.mock.invocationCallOrder[0]!);
  });

  it("does not retire a dead registration without lifecycle when marking failure throws", async () => {
    const dead: RunnerRegistration = {
      ...registration({ pidAlive: false }), lifecycle: null, pid: null, pidStartIdentity: null,
    };
    const subject = makeSubject([dead], Date.now());
    subject.markRunnerFailure.mockRejectedValue(new Error("mark failure failed"));

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.markRunnerFailure).toHaveBeenCalledOnce();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
  });

  it("isolates a disk-full reap write without killing the scan or resuming invented state", async () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const subject = makeSubject([registration({ pidAlive: false })], Date.now(), [], {
      markReaped: vi.fn().mockRejectedValue(error),
    });

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        sessionId: "session-a",
        disposition: "reap_dead",
      }),
      "runner recovery action failed",
    ));

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markRunnerFailure).not.toHaveBeenCalled();
  });

  it("stops scan admission without waiting for an active runner execution", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner: recoveryMockWithReadiness(() => recovery),
      },
    });
    await subject.coordinator.scanOnce();

    let stopped = false;
    const stopping = subject.coordinator.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stoppedBeforeExecution = stopped;

    finishRecovery();
    await stopping;
    await subject.coordinator.waitForSettled();
    expect(stoppedBeforeExecution).toBe(true);
  });

  it("exposes a reconciliation barrier without stopping future scans", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner: recoveryMockWithReadiness(() => recovery),
      },
    });
    await subject.coordinator.scanOnce();

    let settled = false;
    const waiting = subject.coordinator.waitForSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishRecovery();
    await waiting;
    expect(settled).toBe(true);
    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();
  });
});

describe("RunnerRecoveryCoordinator GC cadence", () => {
  it("collects owner-free registrations without waiting for an active recovery", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const active = registration({
      sessionId: "session-a",
      pidAlive: false,
      lifecycleState: "completed",
    });
    const ownerFree = registration({ sessionId: "session-b" });
    ownerFree.pidAlive = false;
    ownerFree.lifecycle!.execution_state = "completed";
    ownerFree.retiredAt = "2026-08-11T00:00:25.000Z";
    const sessionGarbageCollector = {
      collect: vi.fn<RunnerSessionGarbageCollector["collect"]>(async () => ({ removed: [], retained: [] })),
    };
    const subject = makeSubject([active, ownerFree], Date.now(), [], {
      sessionGarbageCollector,
      taskExecutor: {
        recoverRegisteredRunner: recoveryMockWithReadiness((task) =>
          task.agentSessionId === "session-a" ? recovery : Promise.resolve()),
      },
    });

    await subject.coordinator.scanOnce();
    await Promise.resolve();
    const collectedBeforeRecoverySettled = sessionGarbageCollector.collect.mock.calls.map(
      ([scan]) => scan.registrations.map((item) => item.config.sessionId),
    );

    finishRecovery();
    await subject.coordinator.waitForSettled();

    expect(collectedBeforeRecoverySettled).toEqual([["session-b"]]);
  });

  it("runs session state GC at startup and then at most hourly", async () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.retiredAt = "2026-08-11T00:00:00.000Z";
    const sessionGarbageCollector = {
      collect: vi.fn<RunnerSessionGarbageCollector["collect"]>(async () => ({ removed: [], retained: [] })),
    };
    const subject = makeSubject([current], now, [], {
      now: () => now,
      leaseTimeoutMs: 2 * 60 * 60 * 1_000,
      sessionGarbageCollector,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce());
    await subject.coordinator.scanOnce();
    expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce();

    now += 60 * 60 * 1_000;
    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(sessionGarbageCollector.collect).toHaveBeenCalledTimes(2));
  });

  it("does not repeat durable release inspection when the lightweight candidate fingerprint is unchanged", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = { collect: vi.fn(async () => ({ removed: [], retained: [] })) };
    const subject = makeSubject(
      [current],
      Date.now(),
      [],
      { releaseGarbageCollector },
      0,
    );

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();

    current.databaseMtimeMs = 2;
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledTimes(2);

    current.hostDatabaseWalMtimeMs = 3;
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledTimes(3);
  });

  it("skips release GC sweeps inside the minimum interval and resumes after it", async () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = { collect: vi.fn(async () => ({ removed: [], retained: [] })) };
    const subject = makeSubject([current], Date.now(), [], {
      releaseGarbageCollector,
      now: () => now,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce());

    current.databaseMtimeMs = 2;
    now += 9 * 60 * 1_000;
    await subject.coordinator.scanOnce();
    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();

    now += 2 * 60 * 1_000;
    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(releaseGarbageCollector.collect).toHaveBeenCalledTimes(2));
  });

  it("does not run durable release inspection for database churn on an active runner", async () => {
    const current = registration({ pidAlive: true, lifecycleState: "running" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = { collect: vi.fn(async () => ({ removed: [], retained: [] })) };
    const subject = makeSubject(
      [current],
      Date.now(),
      [],
      { releaseGarbageCollector },
      0,
    );

    await subject.coordinator.scanOnce();
    current.databaseMtimeMs = 2;
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();
  });

  it("does not hold the recovery scan open for the release GC sweep", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = {
      collect: vi.fn(() => new Promise<never>(() => {})),
    };
    const subject = makeSubject([current], Date.now(), [], { releaseGarbageCollector });

    await withinBudget(subject.coordinator.scanOnce(), 2_000);

    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();
  });

  it("does not repeat a failed release GC for the same candidates", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = {
      collect: vi.fn(async () => {
        throw new Error("release GC failed");
      }),
    };
    const subject = makeSubject([current], Date.now(), [], { releaseGarbageCollector });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "runner release GC failed",
    ));
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();
  });
});

describe("RunnerRecoveryCoordinator phase observation", () => {
  it("records scan phase durations and clears watchdog context after each phase", async () => {
    let now = 100;
    let activeOperations = 0;
    const contexts: Array<{ phase?: string; scanId?: string; nodeId?: string }> = [];
    const subject = makeSubject([], RECOVERY_NOW_MS, [], {
      monotonicNow: () => now,
      nodeStallMonitor: {
        beginRunnerOperation: (context) => {
          contexts.push(context);
          activeOperations += 1;
          return () => { activeOperations -= 1; };
        },
      },
      scan: async (_stateDirectory, options) => {
        now += 1_007;
        options?.phaseObservation?.runSync("dbRead", {
          sessionId: "session-a",
          databasePath: "/runner/session-a/runner.sqlite",
          label: "test scan read",
        }, () => {});
        return { registrations: [], errors: [] };
      },
    });

    await subject.coordinator.scanOnce();

    expect(contexts.map(({ phase }) => phase)).toEqual([
      "gcWait",
      "registration",
      "dbRead",
      "unreadable",
      "hydration",
      "recoveryReady",
    ]);
    expect(contexts.every(({ nodeId, scanId }) => nodeId === "node-a" && Boolean(scanId)))
      .toBe(true);
    expect(activeOperations).toBe(0);
    expect(subject.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "node-a",
      phaseDurationsMs: expect.objectContaining({ registration: 1_007 }),
      database: expect.objectContaining({ counts: { dbOpen: 0, dbRead: 1, dbClose: 0 } }),
    }), "runner recovery scan completed");
  });

  it("logs an ordinary scan at debug without the database detail", async () => {
    let now = 100;
    const subject = makeSubject([], RECOVERY_NOW_MS, [], {
      monotonicNow: () => now,
      scan: async (_stateDirectory, options) => {
        now += 7;
        options?.phaseObservation?.runSync("dbRead", {
          sessionId: "session-a",
          databasePath: "/runner/session-a/runner.sqlite",
          label: "test scan read",
        }, () => {});
        return { registrations: [], errors: [] };
      },
    });

    await subject.coordinator.scanOnce();

    const scanLines = (calls: unknown[][]) =>
      calls.filter(([, message]) => message === "runner recovery scan completed");
    expect(scanLines(subject.logger.info.mock.calls)).toHaveLength(0);
    const context = scanLines(subject.logger.debug.mock.calls)[0]![0];
    expect(context).toMatchObject({
      durationMs: 7,
      phaseDurationsMs: expect.objectContaining({ registration: 7 }),
    });
    expect(context).not.toHaveProperty("database");
  });

  it("reports registration cache miss reasons in the scan log", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runner-cache-misses-"));
    try {
      const registrationDirectory = join(stateDirectory, "session-cached");
      await mkdir(registrationDirectory, { recursive: true });
      await writeFile(join(registrationDirectory, "runner-config.json"), "{}");
      const cached: RunnerRegistration = {
        ...registration({}),
        pid: null,
        pidAlive: false,
        retiredAt: "2026-10-12T00:00:00.000Z",
      };
      const subject = makeSubject([], RECOVERY_NOW_MS, [], {
        now: () => RECOVERY_NOW_MS,
        scan: async (_stateDirectory, options) => ({
          registrations: [await options!.cache!.read(
            registrationDirectory,
            async () => structuredClone(cached),
          )],
          errors: [],
        }),
      });

      await subject.coordinator.scanOnce();
      await subject.coordinator.scanOnce();

      const completed = subject.logger.debug.mock.calls.filter(
        ([, message]) => message === "runner recovery scan completed",
      );
      expect(completed).toHaveLength(2);
      expect(completed[0]![0]).toMatchObject({
        registrationCacheMisses: {
          uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 1,
        },
      });
      // 두 번째 스캔은 캐시 항목을 그대로 쓴다.
      expect(completed[1]![0]).toMatchObject({
        registrationCacheMisses: {
          uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 0,
        },
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("records a failed phase and finishes its watchdog context without replacing the error", async () => {
    let now = 200;
    let activeOperations = 0;
    const expectedError = new Error("registry failed");
    const subject = makeSubject([], RECOVERY_NOW_MS, [], {
      monotonicNow: () => now,
      nodeStallMonitor: {
        beginRunnerOperation: () => {
          activeOperations += 1;
          return () => { activeOperations -= 1; };
        },
      },
      scan: async () => {
        now += 9;
        throw expectedError;
      },
    });

    await expect(subject.coordinator.scanOnce()).rejects.toBe(expectedError);

    expect(activeOperations).toBe(0);
    expect(subject.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      failurePhase: "registration",
      failureElapsedMs: 9,
    }), "runner recovery scan phase failed");
  });
});

describe("RunnerRecoveryCoordinator central check", () => {
  interface CentralRow {
    node_id: string | null;
    status: string | null;
  }

  function makeCentralSubject(options: {
    tasks: Task[];
    registrations?: RunnerRegistration[];
    readCentralSession: (sessionId: string) => Promise<CentralRow | null>;
    adopt?: (
      task: Task,
      commandId?: string,
    ) => Promise<{ applied: boolean; rejectionReason?: string }>;
    recoverRegisteredRunner?: ReturnType<typeof vi.fn>;
    hydrateRunnerRecoveryTask?: (sessionId: string) => Promise<Task | null>;
    now?: () => number;
    hasPendingRunnerSettlement?: () => boolean;
  }) {
    const forgetRunnerRecoveryTask = vi.fn();
    const subject = makeSubject(
      options.registrations ?? [registration()],
      RECOVERY_NOW_MS,
      [],
      {
        ...(options.now ? { now: options.now } : {}),
        ...(options.hasPendingRunnerSettlement
          ? { hasPendingRunnerSettlement: options.hasPendingRunnerSettlement }
          : {}),
        readCentralSession: options.readCentralSession,
        taskManager: {
          hydrateRunnerRecoveryTask:
            options.hydrateRunnerRecoveryTask ?? vi.fn(async () => null),
          listTasks: () => options.tasks,
          forgetRunnerRecoveryTask,
        } as never,
        taskExecutor: {
          ...(options.adopt
            ? { adoptAttachedRunnerExecution: options.adopt }
            : {}),
          ...(options.recoverRegisteredRunner
            ? { recoverRegisteredRunner: options.recoverRegisteredRunner }
            : {}),
        } as never,
      },
    );
    return { ...subject, forgetRunnerRecoveryTask };
  }

  async function settle(subject: { coordinator: RunnerRecoveryCoordinator }) {
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
  }

  function runningTask(sessionId = "session-a"): {
    task: Task;
    runner: NonNullable<Task["runner"]>;
    detachHost: ReturnType<typeof vi.fn>;
  } {
    const target = task(sessionId);
    const attached = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    target.runner = attached.runner;
    target.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    return { task: target, runner: attached.runner, detachHost: attached.detachHost };
  }

  function terminalRetainedTask(): {
    task: Task;
    runner: NonNullable<Task["runner"]>;
  } {
    const target = task("session-a");
    target.status = "completed";
    target.terminationReason = "completed_ok";
    target.terminationEventRecorded = true;
    target.terminalEventId = 9;
    target.runner = finishedRunner("registration-a").runner;
    target.runnerRetainedForDetachedWork = true;
    return { task: target, runner: target.runner };
  }

  it("reaps a runner whose central session row is gone", async () => {
    const target = task("session-a");
    const { runner, detachHost } = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    target.runner = runner;
    target.callerSessionId = "caller-session";
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => null,
    });

    await settle(subject);

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledWith(
      registration().config.paths,
      "registration-a",
    );
    expect(detachHost).toHaveBeenCalledOnce();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-a" }),
    );
    expect(target.runner).toBeUndefined();
    // Clearing the recipient suppresses the completion delivery a late
    // execution end would otherwise register.
    expect(target.callerSessionId).toBeUndefined();
    expect(subject.markReaped).not.toHaveBeenCalled();
  });

  it("does not adopt or reap a terminal-retained runner while the central row is inactive", async () => {
    const { task: target, runner } = terminalRetainedTask();
    const adopt = vi.fn(async () => ({ applied: true }));
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);

    expect(adopt).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(target.runner).toBe(runner);
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("reaps a terminal-retained runner when the owner node changed", async () => {
    const { task: target } = terminalRetainedTask();
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => ({ node_id: "node-b", status: "running" }),
    });

    await settle(subject);

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(target.runner).toBeUndefined();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-a" }),
    );
  });

  it("changes nothing when the central lookup fails", async () => {
    const { task: target, runner } = runningTask();
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => {
        throw new SessionDataHostError({
          operation: "getSession",
          retryable: true,
          message: "session data host unavailable",
        });
      },
    });

    await settle(subject);

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
    expect(target.runner).toBe(runner);
    expect(subject.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a" }),
      "runner central session lookup failed",
    );
  });

  it("adopts an inactive session's running turn through the attached runner only", async () => {
    const { task: target, detachHost } = runningTask();
    const adopt = vi.fn(async () => ({ applied: true }));
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);

    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledWith(target, "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(detachHost).not.toHaveBeenCalled();
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("reaps after an adoption rejection that is not worth retrying", async () => {
    const { task: target } = runningTask();
    const adopt = vi.fn(async () => ({
      applied: false,
      rejectionReason: "already_terminal",
    }));
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);
    expect(adopt).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();

    await settle(subject);

    expect(adopt).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(target.runner).toBeUndefined();
  });

  // 카드 #1266 U5c: 워크트리 점유 거절은 다시 될 까닭이 없는 거절이다(합의 모형 M:406-412).
  it("reaps after an adoption rejected because another session holds the worktree", async () => {
    const { task: target } = runningTask();
    const adopt = vi.fn(async () => ({
      applied: false,
      rejectionReason: "worktree_busy",
    }));
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);
    expect(adopt).toHaveBeenCalledOnce();

    await settle(subject);

    expect(adopt).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(target.runner).toBeUndefined();
  });

  it.each([
    ["worktree_not_ready", "worktree_not_ready"],
    ["no reason (old server)", undefined],
  ])("keeps a runner whose adoption was rejected with %s", async (_name, rejectionReason) => {
    const { task: target } = runningTask();
    let nowMs = RECOVERY_NOW_MS;
    const adopt = vi.fn(async () => ({
      applied: false,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
    }));
    const subject = makeCentralSubject({
      tasks: [target],
      now: () => nowMs,
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);
    nowMs += 15_000;
    await settle(subject);

    expect(adopt).toHaveBeenCalledTimes(2);
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(target.runner).toBeDefined();
  });

  it("keeps a retryably rejected runner and backs off 15s, 30s, then 5 minutes", async () => {
    const { task: target } = runningTask();
    let nowMs = RECOVERY_NOW_MS;
    const adopt = vi.fn(async () => ({
      applied: false,
      rejectionReason: "still-unknown-to-the-node",
    }));
    const subject = makeCentralSubject({
      tasks: [target],
      now: () => nowMs,
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(target.runner).toBeDefined();

    const expectAttempts = async (advanceMs: number, attempts: number) => {
      nowMs += advanceMs;
      await settle(subject);
      expect(adopt).toHaveBeenCalledTimes(attempts);
    };

    await expectAttempts(14_999, 1);
    await expectAttempts(1, 2);
    await expectAttempts(29_999, 2);
    await expectAttempts(1, 3);
    await expectAttempts(59_999, 3);
    await expectAttempts(1, 4);
    await expectAttempts(119_999, 4);
    await expectAttempts(1, 5);
    await expectAttempts(239_999, 5);
    await expectAttempts(1, 6);
    // The cap is five minutes: the seventh attempt waits the same 300s.
    await expectAttempts(299_999, 6);
    await expectAttempts(1, 7);
    await expectAttempts(299_999, 7);
    await expectAttempts(1, 8);

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(target.runner).toBeDefined();
  });

  it("re-adopts after the interval when startup adoption was retryably rejected", async () => {
    const target = task("session-a");
    target.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    const runner = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
    let nowMs = RECOVERY_NOW_MS;
    const adopt = vi.fn(async () => ({ applied: true }));
    const recoverRegisteredRunner = vi.fn(async (
      owned: Task,
      _registration: RunnerRegistration,
      _commandId: string | undefined,
      _mode: "adopt" | "replay" | "offline",
      onAttemptCreated?: (attempt: NonNullable<Task["runner"]>) => (() => void) | undefined,
      _phaseObservation?: unknown,
      onAdoptionApplication?: (application: {
        applied: boolean;
        rejectionReason?: string;
      }) => void,
    ) => {
      owned.runner = runner;
      onAttemptCreated?.(runner)?.();
      onAdoptionApplication?.({ applied: false, rejectionReason: "worktree_not_ready" });
      throw new RunnerAdoptionRejectedError("session-a", "worktree_not_ready");
    });
    const subject = makeCentralSubject({
      tasks: [target],
      hydrateRunnerRecoveryTask: async () => target,
      now: () => nowMs,
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
      recoverRegisteredRunner,
    });

    await settle(subject);
    expect(recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(adopt).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();

    nowMs += 14_999;
    await settle(subject);
    expect(adopt).not.toHaveBeenCalled();

    nowMs += 1;
    await settle(subject);
    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledWith(target, "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(recoverRegisteredRunner).toHaveBeenCalledOnce();
  });

  // 카드 #1266 U5a 마: 시동 복구의 잇기가 다시 될 수 있는 거절을 받으면 실행 등록이 비어 있거나
  // 이 러너의 것이 아닐 수 있다. 그래도 세션은 다음 주기에 다시 판정되어 다시 잇기로 간다.
  // 조건이 풀릴 수 있다고 분류된 거절(준비 안 됨, 사유 없는 옛 서버 거절)만 다시 잇는다. 어떤 사유가
  // 다시 될 수 있는지는 node_adopt_rejection의 분류가 정하고 여기서는 사유 이름을 따로 다루지 않는다.
  it.each([
    ["has no execution registration at all", undefined, "worktree_not_ready"],
    ["carries another registration's execution", {
      registrationId: "registration-other",
      executionCommandId: "command:44444444-4444-4444-8444-444444444444",
    }, undefined],
  ] as const)(
    "re-adopts after the interval when startup adoption was rejected (%s -> reason %s)",
    async (_name, executionRegistration, reason) => {
      const target = task("session-a");
      if (executionRegistration) target.executionRegistration = { ...executionRegistration };
      const runner = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
      let nowMs = RECOVERY_NOW_MS;
      const adopt = vi.fn(async () => ({ applied: false, rejectionReason: reason }));
      const recoverRegisteredRunner = vi.fn(async (
        owned: Task,
        _registration: RunnerRegistration,
        _commandId: string | undefined,
        _mode: "adopt" | "replay" | "offline",
        onAttemptCreated?: (attempt: NonNullable<Task["runner"]>) => (() => void) | undefined,
        _phaseObservation?: unknown,
        onAdoptionApplication?: (application: {
          applied: boolean;
          rejectionReason?: string;
        }) => void,
      ) => {
        owned.runner = runner;
        onAttemptCreated?.(runner)?.();
        onAdoptionApplication?.({ applied: false, ...(reason === undefined ? {} : { rejectionReason: reason }) });
        throw new RunnerAdoptionRejectedError("session-a", reason);
      });
      const subject = makeCentralSubject({
        tasks: [target],
        hydrateRunnerRecoveryTask: async () => target,
        now: () => nowMs,
        readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
        adopt,
        recoverRegisteredRunner,
      });

      await settle(subject);
      expect(adopt).not.toHaveBeenCalled();

      // 다음 주기(첫 간격 15초) 안에 다시 잇기를 보낸다. keep에 머물지 않는다.
      nowMs += 15_000;
      await settle(subject);
      expect(adopt).toHaveBeenCalledOnce();

      // 그 거절도 다시 될 수 있으면 간격이 늘어난 다음 주기에 또 다시 잇는다.
      nowMs += 29_999;
      await settle(subject);
      expect(adopt).toHaveBeenCalledOnce();
      nowMs += 1;
      await settle(subject);
      expect(adopt).toHaveBeenCalledTimes(2);
      expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    },
  );

  // 낡은 등록의 거절은 같은 러너로 다시 잇는다고 풀리지 않는다. 간격이 몇 번 지나도 잇기를 되풀이하지 않는다.
  it("does not keep re-adopting after a rejection of another registration's transition", async () => {
    const target = task("session-a");
    target.executionRegistration = {
      registrationId: "registration-other",
      executionCommandId: "command:44444444-4444-4444-8444-444444444444",
    };
    const runner = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
    let nowMs = RECOVERY_NOW_MS;
    const adopt = vi.fn(async () => ({ applied: false, rejectionReason: "already_terminal" }));
    const recoverRegisteredRunner = vi.fn(async (
      owned: Task,
      _registration: RunnerRegistration,
      _commandId: string | undefined,
      _mode: "adopt" | "replay" | "offline",
      onAttemptCreated?: (attempt: NonNullable<Task["runner"]>) => (() => void) | undefined,
      _phaseObservation?: unknown,
      onAdoptionApplication?: (application: {
        applied: boolean;
        rejectionReason?: string;
        staleRegistration?: boolean;
      }) => void,
    ) => {
      owned.runner = runner;
      onAttemptCreated?.(runner)?.();
      // 낡은 등록의 거절은 사유가 종료 거절이어도 거둘 수 없어 다시 될 수 있음으로 분류되어 오고, 낡은
      // 등록의 것이라는 표시를 싣는다.
      onAdoptionApplication?.({
        applied: false,
        rejectionReason: "already_terminal",
        staleRegistration: true,
        response: "retryable_rejection",
      } as never);
      throw new RunnerAdoptionRejectedError("session-a", "already_terminal");
    });
    const subject = makeCentralSubject({
      tasks: [target],
      hydrateRunnerRecoveryTask: async () => target,
      now: () => nowMs,
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
      recoverRegisteredRunner,
    });

    await settle(subject);
    for (const step of [15_000, 30_000, 60_000, 300_000, 300_000]) {
      nowMs += step;
      await settle(subject);
    }

    expect(adopt).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(target.runner).toBeDefined();
  });

  it("does not send adoption for a runner without a rejection record when its registration was never applied", async () => {
    const target = task("session-a");
    target.runner = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
    const adopt = vi.fn(async () => ({ applied: true }));
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
    });

    await settle(subject);
    await settle(subject);

    expect(adopt).not.toHaveBeenCalled();
  });

  // 카드 #1266 U5c: 시동 복구 잇기의 점유 거절도 다음 훑기의 중앙 확인이 거둔다.
  it("reaps on the next scan when startup adoption was rejected because the worktree is busy", async () => {
    const target = task("session-a");
    target.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    const runner = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
    let nowMs = RECOVERY_NOW_MS;
    const adopt = vi.fn(async () => ({ applied: true }));
    const recoverRegisteredRunner = vi.fn(async (
      owned: Task,
      _registration: RunnerRegistration,
      _commandId: string | undefined,
      _mode: "adopt" | "replay" | "offline",
      onAttemptCreated?: (attempt: NonNullable<Task["runner"]>) => (() => void) | undefined,
      _phaseObservation?: unknown,
      onAdoptionApplication?: (application: {
        applied: boolean;
        rejectionReason?: string;
      }) => void,
    ) => {
      owned.runner = runner;
      onAttemptCreated?.(runner)?.();
      onAdoptionApplication?.({ applied: false, rejectionReason: "worktree_busy" });
      throw new RunnerAdoptionRejectedError("session-a", "worktree_busy");
    });
    const subject = makeCentralSubject({
      tasks: [target],
      hydrateRunnerRecoveryTask: async () => target,
      now: () => nowMs,
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      adopt,
      recoverRegisteredRunner,
    });

    await settle(subject);
    expect(recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();

    nowMs += 15_000;
    await settle(subject);

    // 목 등록부는 은퇴한 등록을 지우지 않아 같은 훑기의 시동 복구가 다시 붙인다. 거둠 자체만 본다.
    expect(adopt).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(target);
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a" }),
      "runner reaped because the central session no longer carries this execution",
    );
  });

  it("does not block the scan or another session while an adoption response is pending", async () => {
    const first = runningTask("session-a");
    const second = task("session-b");
    second.runner = finishedRunner("registration-a").runner;
    const pending = deferred<{ applied: boolean; rejectionReason?: string }>();
    const adopt = vi.fn(() => pending.promise);
    const subject = makeCentralSubject({
      tasks: [first.task, second],
      registrations: [
        registration({ sessionId: "session-a" }),
        registration({ sessionId: "session-b" }),
      ],
      readCentralSession: async (sessionId) =>
        sessionId === "session-a"
          ? { node_id: "node-a", status: "completed" }
          : null,
      adopt,
    });

    await withinBudget(subject.coordinator.scanOnce(), 2000);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(subject.retireTerminalRegistration)
      .toHaveBeenCalledOnce());
    expect(subject.retireTerminalRegistration).toHaveBeenCalledWith(
      registration({ sessionId: "session-b" }).config.paths,
      "registration-a",
    );
    expect(second.runner).toBeUndefined();

    pending.resolve({ applied: true });
    await subject.coordinator.waitForSettled();
  });

  it("reaps a startup-adopted session while its turn is still running", async () => {
    const target = task("session-a");
    target.callerSessionId = "caller-session";
    target.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    const attached = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let rejectTurn!: (error: unknown) => void;
    const turn = new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
    let recoverySettled = false;
    const recoverRegisteredRunner = vi.fn(async (
      owned: Task,
      _registration: RunnerRegistration,
      _commandId: string | undefined,
      _mode: "adopt" | "replay" | "offline",
      onAttemptCreated?: (attempt: NonNullable<Task["runner"]>) => (() => void) | undefined,
      _phaseObservation?: unknown,
      onAdoptionApplication?: (application: {
        applied: boolean;
        rejectionReason?: string;
      }) => void,
    ) => {
      owned.runner = attached.runner;
      onAttemptCreated?.(attached.runner)?.();
      onAdoptionApplication?.({ applied: true });
      try {
        await turn;
      } finally {
        recoverySettled = true;
      }
    });
    const subject = makeCentralSubject({
      tasks: [target],
      hydrateRunnerRecoveryTask: async () => target,
      readCentralSession: async () => null,
      recoverRegisteredRunner,
    });

    await withinBudget(subject.coordinator.scanOnce(), 2000);
    await vi.waitFor(() => expect(recoverRegisteredRunner).toHaveBeenCalledOnce());
    expect(target.runner).toBe(attached.runner);
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();

    await withinBudget(subject.coordinator.scanOnce(), 2000);
    await vi.waitFor(() => expect(subject.retireTerminalRegistration)
      .toHaveBeenCalledOnce());

    expect(subject.retireTerminalRegistration).toHaveBeenCalledWith(
      registration().config.paths,
      "registration-a",
    );
    expect(attached.detachHost).toHaveBeenCalledOnce();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-a" }),
    );
    expect(target.runner).toBeUndefined();
    expect(target.callerSessionId).toBeUndefined();
    expect(subject.markReaped).not.toHaveBeenCalled();

    // The turn ends only after the reap. Its failure must neither reach
    // adoption failure recovery nor register a completion delivery.
    rejectTurn(new Error("runner host detached by reap"));
    await subject.coordinator.waitForSettled();
    expect(recoverySettled).toBe(true);
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a" }),
      "startup runner adoption failure ignored because the session runner was reaped",
    );
    expect(subject.logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "live runner adoption failed but registration is not safe to replace",
    );
  });

  it("refuses to reap while the runner settlement is pending", async () => {
    const { task: target, runner } = runningTask();
    const subject = makeCentralSubject({
      tasks: [target],
      readCentralSession: async () => null,
      hasPendingRunnerSettlement: () => true,
    });

    await settle(subject);

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
    expect(target.runner).toBe(runner);
    expect(subject.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-a" }),
      "runner central check failed",
    );
  });
});

describe("RunnerRecoveryCoordinator central check card1400 execution boundary", () => {
  async function settle(subject: { coordinator: RunnerRecoveryCoordinator }) {
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
  }

  it("keeps the caller of a newer execution when an older registration is reaped", async () => {
    const target = task("session-a");
    const attached = finishedRunner("registration-new", "execute:33333333-3333-4333-8333-333333333333:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    target.runner = attached.runner;
    target.executionRegistration = {
      registrationId: "registration-new",
      executionCommandId: "command:33333333-3333-4333-8333-333333333333",
    };
    target.callerSessionId = "caller-session";
    const forgetRunnerRecoveryTask = vi.fn();
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      readCentralSession: async () => null,
      taskManager: {
        listTasks: () => [target],
        hydrateRunnerRecoveryTask: async () => null,
        forgetRunnerRecoveryTask,
      } as never,
    });

    await settle(subject);

    // 낡은 등록은 은퇴하지만, 그 등록은 지금 task가 쥔 실행이 아니다.
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).toHaveBeenCalledWith(
      registration().config.paths,
      "registration-a",
    );
    expect(target.runner).toBe(attached.runner);
    expect(attached.detachHost).not.toHaveBeenCalled();
    expect(target.callerSessionId).toBe("caller-session");
    expect(forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("checks a new registration while the previous registration's retry interval is pending", async () => {
    let nowMs = RECOVERY_NOW_MS;
    const scanned: RunnerRegistration[] = [registration()];
    const target = task("session-a");
    target.runner = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
    target.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    const adopt = vi.fn(async (_task: Task, _commandId?: string) => ({
      applied: false,
      rejectionReason: "worktree_not_ready",
    }));
    const subject = makeSubject(scanned, RECOVERY_NOW_MS, [], {
      now: () => nowMs,
      readCentralSession: async () => ({ node_id: "node-a", status: "completed" }),
      taskManager: {
        listTasks: () => [target],
        hydrateRunnerRecoveryTask: async () => null,
      } as never,
      taskExecutor: { adoptAttachedRunnerExecution: adopt } as never,
    });

    await settle(subject);
    expect(adopt).toHaveBeenCalledOnce();

    // 같은 세션에 새 실행이 새 등록으로 시작됐다. 앞 등록의 재시도 간격은 남아 있다.
    const previous = registration();
    const next: RunnerRegistration = {
      ...previous,
      registrationId: "registration-b",
      lifecycle: previous.lifecycle === null
        ? null
        : { ...previous.lifecycle, execution_command_id: "execute:22222222-2222-4222-8222-222222222222:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    };
    scanned.length = 0;
    scanned.push(next);
    target.runner = finishedRunner("registration-b", "execute:22222222-2222-4222-8222-222222222222:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").runner;
    target.executionRegistration = {
      registrationId: "registration-b",
      executionCommandId: "command:22222222-2222-4222-8222-222222222222",
    };
    nowMs += 1_000;
    await settle(subject);

    expect(adopt).toHaveBeenCalledTimes(2);
    expect(adopt.mock.calls.map((call) => call[1])).toEqual(["execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "execute:22222222-2222-4222-8222-222222222222:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("forgets a task whose running execution the reap ended itself", async () => {
    const target = task("session-a");
    const attached = finishedRunner("registration-a", "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    target.runner = attached.runner;
    target.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "command:11111111-1111-4111-8111-111111111111",
    };
    target.executionPromise = new Promise<void>(() => undefined);
    target.callerSessionId = "caller-session";
    // 거둠의 interrupt가 그 턴을 끝내 실행 슬롯을 비운다. 그 자리에 새 실행은 시작되지 않는다.
    (attached.runner.dispatcher as unknown as {
      interrupt: () => Promise<boolean>;
    }).interrupt = vi.fn(async () => {
      target.executionPromise = undefined;
      return true;
    });
    const forgetRunnerRecoveryTask = vi.fn();
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      readCentralSession: async () => null,
      taskManager: {
        listTasks: () => [target],
        hydrateRunnerRecoveryTask: async () => null,
        forgetRunnerRecoveryTask,
      } as never,
    });

    await settle(subject);

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(forgetRunnerRecoveryTask).toHaveBeenCalledWith(target);
  });
});

describe("runner registration whose session no longer exists", () => {
  it("keeps a live runner's registration and warns once per registration", async () => {
    const live = registration({ pidAlive: true, lifecycleState: "running" });
    const subject = makeSubject([live], RECOVERY_NOW_MS, [], {
      taskManager: { hydrateRunnerRecoveryTask: async () => null },
    });
    const missingWarnings = () => subject.logger.warn.mock.calls.filter(
      ([, message]) => message === "runner registration has no durable session",
    );

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();

    expect(missingWarnings()).toHaveLength(1);
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.invalidateRegistration).not.toHaveBeenCalled();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
  });
});

function makeSubject(
  registrations: RunnerRegistration[],
  now = Date.parse("2026-08-11T00:00:30.000Z"),
  errors: Array<{ directory: string; error: Error }> = [],
  overrides: Omit<Partial<RunnerRecoveryCoordinatorOptions>, "taskExecutor" | "taskManager"> & {
    taskExecutor?: Partial<RunnerRecoveryCoordinatorOptions["taskExecutor"]>;
    taskManager?: Partial<RunnerRecoveryCoordinatorOptions["taskManager"]>;
  } = {},
  releaseGcMinIntervalMs?: number,
) {
  const tasks = new Map<string, Task>();
  for (const item of registrations) {
    tasks.set(item.config.sessionId, task(item.config.sessionId));
  }
  const fallbackTask = task("session-a");
  const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) =>
    tasks.get(sessionId) ?? fallbackTask);
  const recoverRegisteredRunner = vi.fn(async () => {});
  const retainRegisteredDetachedRunner = vi.fn(async () => false);
  const releaseExpiredRetainedRunner = vi.fn(async () => "not_released" as const);
  const completeRetainedRunnerReleaseAfterTermination = vi.fn(() => false);
  const markRunnerFailure = vi.fn(async () => {});
  const projectClosedRunner = vi.fn(async () => true);
  const terminate = vi.fn<RunnerProcessSpawner["terminate"]>(async () => "registration_invalidated" as const);
  const invalidateRegistration = vi.fn(async () => {});
  const retireTerminalRegistration = vi.fn(async () => {});
  const markReaped = vi.fn(async () => {});
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const baseTaskManager = {
    hydrateRunnerRecoveryTask,
    listExistingSessionIds: vi.fn(async (ids: string[]) => ids),
    markRunnerFailure,
    projectClosedRunner,
  };
  const options: RunnerRecoveryCoordinatorOptions = {
    nodeId: "node-a",
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    closedTailDrainer: { drain: vi.fn(async () => {}) },
    logger,
    spawner: { terminate, invalidateRegistration, retireTerminalRegistration },
    scan: async () => structuredClone({ registrations, errors }),
    hydrate: async (registration) => registration,
    now: () => now,
    markReaped,
    recoveryStorage,
    ...overrides,
    taskExecutor: {
      recoverRegisteredRunner,
      retainRegisteredDetachedRunner,
      releaseExpiredRetainedRunner,
      completeRetainedRunnerReleaseAfterTermination,
      ...overrides.taskExecutor,
    },
    taskManager: {
      ...baseTaskManager,
      ...overrides.taskManager,
    },
  };
  return {
    coordinator: new RunnerRecoveryCoordinator(options, releaseGcMinIntervalMs),
    task: tasks.get("session-a") ?? fallbackTask,
    hydrateRunnerRecoveryTask,
    recoverRegisteredRunner,
    retainRegisteredDetachedRunner,
    releaseExpiredRetainedRunner,
    completeRetainedRunnerReleaseAfterTermination,
    markRunnerFailure,
    projectClosedRunner,
    markReaped,
    terminate,
    invalidateRegistration,
    retireTerminalRegistration,
    logger,
  };
}

function recoveryMockWithReadiness(
  recoveryFor: (task: Task) => Promise<void>,
) {
  const attempt = failedRecoveryRunner().runner;
  return vi.fn((
    recovered: Task,
    _registration: RunnerRegistration,
    _commandId: string | undefined,
    _mode: "adopt" | "replay" | "offline",
    onAttemptCreated?: (
      runner: NonNullable<Task["runner"]>,
    ) => (() => void) | undefined,
  ) => {
    const markReady = onAttemptCreated?.(attempt);
    markReady?.();
    return recoveryFor(recovered);
  });
}

function finishedRunner(
  registrationId = "registration-a",
  activeExecutionCommandId?: string,
  onRetire: () => Promise<void> = async () => {},
): {
  runner: NonNullable<Task["runner"]>;
  detachHost: ReturnType<typeof vi.fn>;
  retireTerminalRegistration: ReturnType<typeof vi.fn>;
} {
  const detachHost = vi.fn(async () => {});
  const retireTerminalRegistration = vi.fn(
    async (beforeRegistrationRetired?: () => Promise<void>) => {
      await onRetire();
      await beforeRegistrationRetired?.();
    },
  );
  return {
    runner: {
      dispatcher: {
        detachHost,
        retireTerminalRegistration,
        isClosed: () => false,
        hasActiveExecution: () => activeExecutionCommandId !== undefined,
        activeExecutionCommandId: () => activeExecutionCommandId,
        dispatcherId: () => "live-one",
        registrationId: () => registrationId,
      } as unknown as NonNullable<Task["runner"]>["dispatcher"],
      engine: {} as NonNullable<Task["runner"]>["engine"],
      eventPersistence: "runner",
    },
    detachHost,
    retireTerminalRegistration,
  };
}

function abandonedRunner(): NonNullable<Task["runner"]> {
  return {
    dispatcher: {
      detachHost: vi.fn(async () => {}),
      isClosed: () => true,
      hasActiveExecution: () => false,
      registrationId: () => "registration-a",
    } as unknown as NonNullable<Task["runner"]>["dispatcher"],
    engine: {} as NonNullable<Task["runner"]>["engine"],
    eventPersistence: "runner",
  };
}

function failureContext(message: string) {
  return expect.objectContaining({
    directory: "/runner/a",
    sessionId: "session-a",
    err: expect.objectContaining({ message }),
  });
}

function runnerSocketMissingError(): Error {
  return new Error("Runner socket unavailable after 10000ms deadline", {
    cause: Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
  });
}

function failedRecoveryRunner(): {
  runner: NonNullable<Task["runner"]>;
  detachHost: ReturnType<typeof vi.fn>;
} {
  const detachHost = vi.fn(async () => {});
  return {
    runner: {
      dispatcher: {
        detachHost: async () => await detachHost(),
        hasActiveExecution: (): boolean => false,
        registrationId: (): string | undefined => "registration-a",
      } as NonNullable<Task["runner"]>["dispatcher"],
      engine: {} as NonNullable<Task["runner"]>["engine"],
      eventPersistence: "runner",
    },
    detachHost,
  };
}

function registration(options: {
  sessionId?: string;
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed";
  progressedAt?: string;
  terminalError?: { code: string; message: string } | null;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: {
        id: "agent-a",
        name: "Agent A",
        backend: "codex",
        workspace_dir: "/workspace/a",
      },
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`,
        pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`,
        configPath: `/runner/${sessionId}/runner-config.json`,
        socketKind: "unix_socket",
        logPath: `/runner/${sessionId}/runner.log`,
      },
      codeSha: "sha-a",
      snapshotPath: "/release/sha-a/soul-server-ts",
      codexAdapterMode: "sdk",
      codexDetachedResultRetentionMs: 1_800_000,
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4123,
    registrationId: "registration-a",
    pidStartIdentity: "start-4123",
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-11T00:00:00.000Z"),
    bootstrap: {
      stream_id: `stream-${sessionId}`,
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: `backend-${sessionId}`,
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-08-11T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      execution_state: options.lifecycleState ?? "running",
      progress_seq: 3,
      progress_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      liveness_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      in_flight_tools: [],
      terminal_error: options.terminalError ?? null,
    },
  };
}

function retiredWithTail(sessionId: string, lifecycleState: "running" | "completed" | "failed"): RunnerRegistration {
  const current = registration({ sessionId, pidAlive: false, lifecycleState });
  current.retiredAt = "2026-08-11T00:00:00.000Z";
  current.closedTailState = {
    status: "requires_drain", streamId: `stream-${sessionId}`, sessionId,
    latestDurableSourceSeq: 3, acknowledgedThrough: 2,
  };
  return current;
}

async function releasedTerminalSidecarFixture(options: {
  lifecyclePid?: number;
  identityPid?: number;
  identityStartIdentity?: string;
} = {}): Promise<{
  root: string;
  paths: ReturnType<typeof runnerProcessPaths>;
  registration: RunnerRegistration;
  spawner: RunnerProcessSpawner;
  staleLifecyclePid: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "runner-released-live-shape-"));
  const paths = runnerProcessPaths(join(root, "runner-state"), "session-a");
  await mkdir(paths.sessionDirectory, { recursive: true });
  const staleLifecyclePid = options.lifecyclePid ?? 2_450_746;
  const registrationId = "registration-live-sidecar";
  const template = registration();
  const config = {
    ...template.config,
    paths,
    codeSha: "sha256-b271cc86",
    releaseManifestId: "sha256-d8dc3e37",
    runtimeEnvIdentity: "sha256-51ae3e79",
  };
  await writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
    schemaVersion: 1,
    registrationId,
    sessionId: config.sessionId,
    codeSha: config.codeSha,
    releaseManifestId: config.releaseManifestId,
    runtimeEnvIdentity: config.runtimeEnvIdentity,
    pid: options.identityPid ?? null,
    startIdentity: options.identityStartIdentity ?? null,
  });
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  outbox.close();
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, config.sessionId);
  lifecycle.begin({
    pid: staleLifecyclePid,
    commandId: "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    progressedAt: "2026-08-11T00:00:20.000Z",
  });
  const completedLifecycle = lifecycle.finish(
    "execute:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "completed",
    "2026-08-11T00:00:30.000Z",
  );
  lifecycle.close();
  await writeFile(
    runnerLifecycleSummaryPath(paths.databasePath),
    `${JSON.stringify(completedLifecycle)}\n`,
    { mode: 0o600 },
  );
  const current = await readRunnerRegistrationSummary(paths.sessionDirectory, { recoveryStorage });
  const spawner = new RunnerProcessSpawner({
    prepareDatabase: async () => {},
    validateEntry: async () => {},
    spawnProcess: () => ({ pid: 880_002, unref: vi.fn() }),
    registerPid: async () => {},
    inspectProcess: async () => ({ alive: false, startIdentity: null }),
    isPidAlive: () => false,
    signalPid: vi.fn(),
    now: () => RECOVERY_NOW_MS,
    delay: async () => {},
  });
  return { root, paths, registration: current, spawner, staleLifecyclePid };
}

function recordTerminalCompletion(task: Task): void {
  task.status = "completed";
  task.terminationReason = "completed_ok";
  task.terminationEventRecorded = true;
  task.terminalEventId = 3;
  task.runner = undefined;
  task.executionPromise = undefined;
  task.executionRegistration = undefined;
}

async function withinBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`exceeded ${budgetMs}ms budget`)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([promise, budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function task(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "continue",
    status: "running",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}
