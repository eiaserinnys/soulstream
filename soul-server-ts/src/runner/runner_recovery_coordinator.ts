import { performance } from "node:perf_hooks";
import { ExecutionOwnershipBackoff } from "../task/execution_ownership_backoff.js";
import type { Task } from "../task/task_models.js";
import { releaseTaskRunner } from "../task/task_runner_release.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
  runnerReleaseGcCandidateFingerprint,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import { RunnerRecoveryHydrationPhase } from "./runner_recovery_hydration_phase.js";
import { RunnerRecoveryLogger } from "./runner_recovery_logging.js";
import {
  contendsForExecutionOwnership,
  dispositionRequiresTask,
  handleRecoveryWithFailureTracking,
  reapAndResumeRunner,
  recoverRunnerByDisposition,
  resumeReapedRunner,
  type RecoverableRunnerDisposition,
} from "./runner_recovery_disposition.js";
import { classifyRunnerRegistrationSafely } from "./runner_recovery_classification.js";
import {
  markRegistrationReaped,
  prepareRecoveredTask,
  requireRecoveryTask,
} from "./runner_recovery_task.js";
import { RunnerRegistrationControl } from "./runner_registration_control.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";
import type { ClosedRunnerTailDrainer } from "./closed_runner_tail_drainer.js";
import {
  closedRunnerTailRequiresDrain,
  logRunnerRecoveryScan,
} from "./runner_recovery_scan_observer.js";
import {
  RunnerAdoptionFailureRecovery,
  type RunnerAdoptionDisposition,
} from "./runner_adoption_failure_recovery.js";
import type { RunnerRecoveryCoordinatorOptions } from "./runner_recovery_coordinator_options.js";
import type { TaskRunnerRuntime } from "./task_runner_runtime.js";
import { OwnerNullExecutionReconciler } from "./owner_null_execution_reconciler.js";
import { OwnerNullInventoryReconciler } from "./owner_null_inventory_reconciler.js";
import { RunnerSessionGarbageCollectionScheduler } from "./runner_session_gc_scheduler.js";
import { UnreadableRunnerRegistrationHandler } from "./unreadable_runner_registration_handler.js";
import { runnerProcessPaths } from "./runner_process_paths.js";
import type { OwnerNullRunningSessionRow } from "../db/session_db_types.js";
export type { RunnerRecoveryCoordinatorOptions } from "./runner_recovery_coordinator_options.js";
/** Owns runner adoption and failure recovery; no domain state is derived here. */
export class RunnerRecoveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly ownerNullExecutionReconciler: OwnerNullExecutionReconciler;
  private readonly ownerNullInventoryReconciler: OwnerNullInventoryReconciler;
  private scanInFlight: Promise<void> | undefined;
  private releaseGarbageCollectionFingerprint: string | undefined;
  private readonly recoveryLogger: RunnerRecoveryLogger;
  private readonly hydrationPhase: RunnerRecoveryHydrationPhase;
  private readonly adoptionFailureRecovery: RunnerAdoptionFailureRecovery;
  private readonly sessionGarbageCollectionScheduler: RunnerSessionGarbageCollectionScheduler;
  private readonly unreadableRegistrationHandler: UnreadableRunnerRegistrationHandler;
  private readonly registrationControl: RunnerRegistrationControl;
  private readonly ownershipBackoff: ExecutionOwnershipBackoff;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly options: RunnerRecoveryCoordinatorOptions) {
    this.registrationControl = new RunnerRegistrationControl(options.spawner);
    this.ownershipBackoff = options.ownershipBackoff
      ?? new ExecutionOwnershipBackoff({
        logger: options.logger,
        ...(options.now ? { now: options.now } : {}),
      });
    this.ownerNullExecutionReconciler = new OwnerNullExecutionReconciler(options);
    this.ownerNullInventoryReconciler = new OwnerNullInventoryReconciler({
      nodeId: options.nodeId,
      scanIntervalMs: options.scanIntervalMs,
      leaseTimeoutMs: options.leaseTimeoutMs,
      taskManager: options.taskManager as Required<Pick<
        typeof options.taskManager,
        "listOwnerNullRunningInventory" | "hydrateRunnerRecoveryTask"
          | "reconcileExecutionOwnershipObservations"
          | "reconcileTerminalExecutionOwnership"
      >>,
      retireTerminalOwnership: async (row, commit) =>
        await this.retireTerminalOwnership(row, commit),
      logger: options.logger,
      now: options.now ?? Date.now,
    });
    this.sessionGarbageCollectionScheduler = new RunnerSessionGarbageCollectionScheduler({
      ...(options.sessionGarbageCollector
        ? { collector: options.sessionGarbageCollector }
        : {}),
      logger: options.logger,
      now: options.now ?? Date.now,
    });
    this.unreadableRegistrationHandler = new UnreadableRunnerRegistrationHandler({
      stateDirectory: options.stateDirectory,
      logger: options.logger,
      ...(options.quarantineFailure
        ? { quarantineFailure: options.quarantineFailure }
        : {}),
    });
    this.recoveryLogger = new RunnerRecoveryLogger({
      logger: options.logger,
      now: options.now ?? Date.now,
    });
    this.hydrationPhase = new RunnerRecoveryHydrationPhase({
      hydrate: async (sessionId) =>
        await options.taskManager.hydrateRunnerRecoveryTask(sessionId),
      ...(options.hydrationDeadlineMs === undefined
        ? {}
        : { deadlineMs: options.hydrationDeadlineMs }),
      ...(options.hydrationConcurrency === undefined
        ? {}
        : { concurrency: options.hydrationConcurrency }),
    });
    this.adoptionFailureRecovery = new RunnerAdoptionFailureRecovery({
      leaseTimeoutMs: options.leaseTimeoutMs,
      logger: options.logger,
      ...(options.now ? { now: options.now } : {}),
      ...(options.refreshRegistration
        ? { refreshRegistration: options.refreshRegistration }
        : {}),
      ...(options.hydrate ? { hydrateRegistration: options.hydrate } : {}),
      terminateRegistration: async (registration) => {
        await this.registrationControl.terminate(registration);
      },
      invalidateRegistration: async (registration) =>
        await this.registrationControl.invalidate(registration),
      markReaped: async (registration, progressedAt, error) => {
        if (options.markReaped) {
          await options.markReaped(registration, progressedAt, error);
        } else {
          await markRegistrationReaped(registration, progressedAt, error, options.logger);
        }
      },
      recoverOffline: async (registration, task) =>
        (await this.recoverRegistered(registration, task, "offline")).task,
      resumeReplacement: async (task, message, config) =>
        await this.resumeReplacement(task, message, config),
      onFailure: (registration, disposition, error) =>
        this.recoveryLogger.failure(registration, disposition, error),
    });
  }

  private async retireTerminalOwnership(
    row: OwnerNullRunningSessionRow,
    commit: () => Promise<boolean>,
  ): Promise<void> {
    const registrationId = row.registration_id;
    const pid = row.pid;
    const startIdentity = row.start_identity;
    if (
      !registrationId
      || typeof pid !== "number"
      || !Number.isSafeInteger(pid)
      || pid <= 0
      || !startIdentity
    ) {
      throw new Error(`terminal active ownership identity incomplete: ${row.session_id}`);
    }
    await this.registrationControl.retireTerminalOwnership(
      runnerProcessPaths(this.options.stateDirectory, row.session_id),
      { registrationId, pid, startIdentity },
      commit,
    );
  }
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.scanOnce();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error) => {
        this.options.logger.error({ err: error }, "runner recovery scan failed");
      });
    }, this.options.scanIntervalMs);
    this.timer.unref?.();
  }
  async scanOnce(): Promise<void> {
    if (this.stopped) return;
    this.scanInFlight ??= this.performScan().finally(() => {
      this.scanInFlight = undefined;
    });
    await this.scanInFlight;
  }
  private async performScan(): Promise<void> {
    const monotonicNow = this.options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    if (this.sessionGarbageCollectionScheduler.inFlight) {
      await this.sessionGarbageCollectionScheduler.inFlight;
    }
    const scan = await (this.options.scan ?? scanRunnerRegistrations)(
      this.options.stateDirectory,
    );
    this.ownerNullExecutionReconciler.prune(scan.registrations);
    const terminalOwnershipSessionIds =
      await this.ownerNullInventoryReconciler.reconcile(scan.registrations);
    await this.unreadableRegistrationHandler.handle(scan.errors);
    this.recoveryLogger.prune(scan.registrations);
    this.ownershipBackoff.prune(
      scan.registrations.map((registration) => registration.config.sessionId),
    );
    this.adoptionFailureRecovery.prune(
      scan.registrations.map((registration) => registration.config.sessionId),
    );
    const admitted: Array<{
      registration: RunnerRegistration;
      disposition: RunnerRecoveryDisposition;
    }> = [];
    for (const registration of scan.registrations) {
      const sessionId = registration.config.sessionId;
      if (
        terminalOwnershipSessionIds.has(sessionId)
        || this.active.has(sessionId)
        || this.adoptionFailureRecovery.has(sessionId)
      ) continue;
      const disposition = classifyRunnerRegistrationSafely(
        registration,
        (this.options.now ?? Date.now)(),
        this.options.leaseTimeoutMs,
        (error) => this.recoveryLogger.classification(registration, error),
      );
      if (!disposition) continue;
      if (
        (disposition === "adopt_prebootstrap" || disposition === "adopt_running")
        && this.adoptionFailureRecovery.shouldSkip(sessionId)
      ) continue;
      if (
        disposition === "wait_for_bootstrap"
      ) {
        this.recoveryLogger.clear(sessionId);
        continue;
      }
      if (disposition === "retired_terminal") {
        this.recoveryLogger.clear(sessionId);
        continue;
      }
      // The ownership backoff only governs work that goes on to claim
      // ownership. Reaping a dead runner, draining a closed one, or
      // reconciling an owner-null row neither contends for ownership nor
      // benefits from waiting — and holding those back for five minutes would
      // leave a session with a dead runner stranded exactly as long.
      if (
        contendsForExecutionOwnership(disposition)
        && this.ownershipBackoff.shouldSkip(sessionId)
      ) continue;
      admitted.push({ registration, disposition });
    }
    const hydrationOutcomes = await this.hydrationPhase.run(
      admitted.filter(({ disposition }) => dispositionRequiresTask(disposition)),
    );
    const hydrationBySession = new Map(
      hydrationOutcomes.map((outcome) => [
        outcome.registration.config.sessionId,
        outcome,
      ]),
    );
    for (const { registration, disposition } of admitted) {
      const sessionId = registration.config.sessionId;
      const outcome = hydrationBySession.get(sessionId);
      if (outcome && outcome.status !== "ready") {
        this.recoveryLogger.hydration(outcome);
        continue;
      }
      const task = outcome?.status === "ready" ? outcome.task : undefined;
      if (
        task
        && (disposition === "adopt_prebootstrap" || disposition === "adopt_running")
      ) {
        const ownerNullDisposition = await this.ownerNullExecutionReconciler.reconcile(
          task,
          registration,
        );
        if (ownerNullDisposition === "wait") continue;
        if (ownerNullDisposition === "terminal") {
          if (registration.pidAlive) await this.registrationControl.terminate(registration);
          continue;
        }
      }
      const recovery = this.handleWithFailureTracking(registration, disposition, task)
        .finally(() => {
          if (this.active.get(sessionId) === recovery) this.active.delete(sessionId);
        });
      this.active.set(sessionId, recovery);
    }
    const releaseFingerprint = runnerReleaseGcCandidateFingerprint(scan);
    if (
      this.options.releaseGarbageCollector
      && releaseFingerprint !== this.releaseGarbageCollectionFingerprint
    ) {
      try {
        await this.options.releaseGarbageCollector.collect(scan);
        this.releaseGarbageCollectionFingerprint = releaseFingerprint;
      } catch (error) {
        this.options.logger.error({ err: error }, "runner release GC failed");
      }
    }
    this.sessionGarbageCollectionScheduler.schedule({
      ...scan,
      registrations: scan.registrations.filter(
        (registration) => !this.active.has(registration.config.sessionId),
      ),
    });
    logRunnerRecoveryScan(
      this.options.logger,
      admitted.map(({ registration }) => registration),
      startedAt,
      monotonicNow(),
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.scanInFlight) await this.scanInFlight;
    await this.sessionGarbageCollectionScheduler.inFlight;
  }
  /** Waits for recovery work already admitted by a scan without stopping the coordinator. */
  async waitForSettled(): Promise<void> {
    while (
      this.scanInFlight
      || this.active.size > 0
      || this.adoptionFailureRecovery.pending().length > 0
    ) {
      await Promise.allSettled([
        ...(this.scanInFlight ? [this.scanInFlight] : []),
        ...this.active.values(),
        ...this.adoptionFailureRecovery.pending(),
      ]);
    }
  }
  private async resumeReplacement(
    task: Task,
    message: string,
    config: RunnerRegistration["config"],
  ): Promise<void> {
    await this.options.taskManager.markRunnerFailureAndResume(
      task,
      message,
      (resumedTask) => {
        if (this.stopped) return;
        return this.options.taskExecutor.restartRegisteredRunner(
          resumedTask,
          config,
        );
      },
    );
  }
  private async handle(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
  ): Promise<void> {
    if (
      disposition === "adopt_prebootstrap"
      || disposition === "adopt_running"
      || disposition === "replay_terminal"
      || disposition === "replay_terminal_dead"
    ) {
      await this.recoverByDisposition(
        registration,
        disposition,
        requireRecoveryTask(task, registration),
      );
      return;
    }
    if (disposition === "reap_dead" || disposition === "reap_stalled") {
      await this.reapAndResume(
        registration,
        disposition,
        requireRecoveryTask(task, registration),
      );
      return;
    }
    if (disposition === "closed") {
      const recoveredTask = requireRecoveryTask(task, registration);
      const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(registration);
      const verifiedDisposition = classifyRunnerRegistration(
        hydrated,
        (this.options.now ?? Date.now)(),
        this.options.leaseTimeoutMs,
      );
      if (verifiedDisposition !== "closed") {
        if (
          verifiedDisposition === "adopt_prebootstrap"
          || verifiedDisposition === "adopt_running"
          || verifiedDisposition === "replay_terminal"
          || verifiedDisposition === "replay_terminal_dead"
        ) {
          await this.recoverByDisposition(hydrated, verifiedDisposition, recoveredTask);
        }
        return;
      }
      if (hydrated.pidAlive) await this.registrationControl.terminate(hydrated);
      const closedRegistration = { ...hydrated, pidAlive: false };
      if (closedRunnerTailRequiresDrain(closedRegistration)) {
        await this.options.closedTailDrainer.drain(closedRegistration);
      }
      if (recoveredTask.executionOwnership) {
        prepareRecoveredTask(recoveredTask, closedRegistration);
      }
      const projectClosedRunner = this.options.taskManager.projectClosedRunner;
      if (!projectClosedRunner) {
        throw new Error("closed runner central projection is not configured");
      }
      await projectClosedRunner.call(
        this.options.taskManager,
        recoveredTask,
        "runner lifecycle closed during startup recovery",
      );
      return;
    }
    if (disposition === "already_reaped") {
      await resumeReapedRunner({
        registration,
        task: requireRecoveryTask(task, registration),
        ...(this.options.hydrate ? { hydrate: this.options.hydrate } : {}),
        terminate: async (owned) => {
          await this.registrationControl.terminate(owned);
        },
        invalidate: async (owned) => await this.registrationControl.invalidate(owned),
        recoverOffline: async (owned, recoveredTask) =>
          (await this.recoverRegistered(owned, recoveredTask, "offline")).task,
        resumeReplacement: async (recoveredTask, message, config) =>
          await this.resumeReplacement(recoveredTask, message, config),
        logger: this.options.logger,
      });
      return;
    }
    throw new Error(`unsupported runner recovery disposition: ${disposition}`);
  }
  private async handleWithFailureTracking(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
  ): Promise<void> {
    await handleRecoveryWithFailureTracking({
      registration,
      disposition,
      ...(task ? { task } : {}),
      handle: async (owned, ownedDisposition, recoveredTask) =>
        await this.handle(owned, ownedDisposition, recoveredTask),
      recoveryLogger: this.recoveryLogger,
      ownershipBackoff: this.ownershipBackoff,
    });
  }
  private async recoverRegistered(
    registration: RunnerRegistration,
    task: Task,
    mode: "adopt" | "replay" | "offline",
    prepareRegistrationAfterTaskGuard?: (
      registration: RunnerRegistration,
    ) => Promise<RunnerRegistration>,
    adoptionDisposition?: RunnerAdoptionDisposition,
  ): Promise<{ task: Task; replayed: boolean }> {
    // An offline recovery is only reached when the registration on disk says
    // this runner finished. The host is not always told: the dispatcher stays
    // open, holding the task, delivering nothing, and every replay after it is
    // refused against a runner that has nothing left to run. Measured, that is
    // thirteen skips at fifteen seconds each before the runner process happens
    // to exit -- and when it never exits, forever (260822).
    //
    // Detaching here cannot starve a turn: a terminal lifecycle means the turn
    // is over, and the frames it has left are durable in the runner's own
    // outbox, which is what the offline replay reads. That is the difference
    // from `detachHost` on a runner still working, which stranded a live tool.
    if (
      mode === "offline"
      && task.runner
      && registrationOwnsAttachedRunner(task, registration)
    ) {
      this.options.logger.warn(
        {
          sessionId: registration.config.sessionId,
          runnerDispatcher: task.runner.dispatcher.dispatcherId?.(),
          runnerDispatcherClosed: task.runner.dispatcher.isClosed?.(),
        },
        "detaching a finished runner so its own replay can run",
      );
      const finished = task.runner;
      releaseTaskRunner(task, finished);
      // Letting go of the handle is only half of it. `detachHost` releases the
      // host's resources but never settles the execution it was consuming, so
      // the promise stays pending forever and the slot is never cleared -- the
      // skip simply changes from `runner` to `execution_promise` and the same
      // thirteen scans go by. Shutdown already states the whole gesture:
      // detach, drop the runner, drop the execution (task_lifecycle_route).
      task.executionPromise = undefined;
      await finished.dispatcher.detachHost().catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, sessionId: registration.config.sessionId },
          "finished runner host detach failed before replay",
        );
      });
    }
    if (
      task.runner?.dispatcher.isClosed?.() === true
      && registrationOwnsAttachedRunner(task, registration)
    ) {
      this.options.logger.warn(
        { sessionId: registration.config.sessionId, mode },
        "releasing a runner the host has given up so recovery can take over",
      );
      releaseTaskRunner(task, task.runner);
    }
    if (task.runner || task.executionPromise) {
      // This guard returned in silence for three hours during the 260822
      // outage: a settled execution promise left behind by a failed ownership
      // reservation reads exactly like a live execution, so every later scan
      // skipped the offline replay without saying so. An offline replay that
      // cannot run is a stranded terminal fact, never routine.
      this.options.logger[mode === "offline" ? "warn" : "info"](
        {
          sessionId: registration.config.sessionId,
          mode,
          blockedBy: task.runner ? "runner" : "execution_promise",
          taskStatus: task.status,
          // Which dispatcher, and whether it has already given up. A session
          // can hold one while another for the same session is the one whose
          // reconnect budget ran out, and the two are indistinguishable
          // without saying so.
          runnerDispatcher: task.runner?.dispatcher.dispatcherId?.(),
          runnerDispatcherClosed: task.runner?.dispatcher.isClosed?.(),
        },
        "registered runner recovery skipped because the task still holds an execution",
      );
      return { task, replayed: false };
    }
    if (prepareRegistrationAfterTaskGuard) {
      registration = await prepareRegistrationAfterTaskGuard(registration);
    }
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(registration);
    const lifecycle = hydrated.lifecycle;
    prepareRecoveredTask(task, hydrated);
    let attemptRunner: TaskRunnerRuntime | undefined;
    const completion = this.options.taskExecutor.recoverRegisteredRunner(
      task,
      hydrated,
      lifecycle?.execution_command_id,
      mode,
      (runner) => {
        attemptRunner = runner;
      },
    );
    const ownedRunner = task.runner;
    if (mode === "offline") {
      await completion;
    } else if (mode === "adopt" && adoptionDisposition) {
      try {
        await completion;
        this.adoptionFailureRecovery.clear(registration.config.sessionId);
      } catch (error) {
        await this.adoptionFailureRecovery.schedule({
          registration,
          disposition: adoptionDisposition,
          task,
          completion,
          ownedRunner,
          attemptRunner,
          error,
        });
      }
    } else {
      void completion.catch((error) => {
        this.options.logger.error(
          { err: error, sessionId: registration.config.sessionId },
          "live runner host consumption failed",
        );
      });
    }
    return { task, replayed: true };
  }

  private async reapAndResume(
    registration: RunnerRegistration,
    disposition: "reap_dead" | "reap_stalled",
    task: Task,
  ): Promise<void> {
    await reapAndResumeRunner({
      registration,
      disposition,
      task,
      ...(this.options.hydrate ? { hydrate: this.options.hydrate } : {}),
      now: this.options.now ?? Date.now,
      leaseTimeoutMs: this.options.leaseTimeoutMs,
      recover: async (owned, verified, recoveredTask) =>
        await this.recoverByDisposition(owned, verified, recoveredTask),
      terminalize: async (owned, recoveredTask, error, verified) =>
        await this.adoptionFailureRecovery.terminalize(
          owned,
          recoveredTask,
          error,
          verified,
        ),
    });
  }

  private async recoverByDisposition(
    registration: RunnerRegistration,
    disposition: RecoverableRunnerDisposition,
    task: Task,
  ): Promise<Task> {
    return await recoverRunnerByDisposition({
      registration,
      disposition,
      task,
      recoverAdopt: async (ownedRegistration, ownedTask, adoptionDisposition) =>
        (await this.recoverRegistered(
          ownedRegistration,
          ownedTask,
          "adopt",
          undefined,
          adoptionDisposition,
        )).task,
      recoverOffline: async (ownedRegistration, ownedTask, prepare) =>
        await this.recoverRegistered(ownedRegistration, ownedTask, "offline", prepare),
      terminate: async (ownedRegistration) =>
        await this.registrationControl.terminate(ownedRegistration),
      retireTerminal: async (ownedRegistration) =>
        await this.registrationControl.retireTerminal(ownedRegistration),
      logger: this.options.logger,
    });
  }
}

function registrationOwnsAttachedRunner(
  task: Task,
  registration: RunnerRegistration,
): boolean {
  const attachedRegistrationId = task.runner?.dispatcher.registrationId();
  return attachedRegistrationId !== undefined
    && registration.registrationId === attachedRegistrationId;
}
