import { performance } from "node:perf_hooks";
import { isTerminalTaskStatus, type Task } from "../task/task_models.js";
import { releaseTaskRunner } from "../task/task_runner_release.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
  isTerminalRunnerExecutionState,
  runnerReleaseGcCandidateFingerprint,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import { RunnerRecoveryHydrationPhase } from "./runner_recovery_hydration_phase.js";
import { RunnerRecoveryLogger } from "./runner_recovery_logging.js";
import {
  dispositionRequiresTask,
  handleRecoveryWithFailureTracking,
  terminalizeFailedRunner,
  recoverRunnerByDisposition,
  terminalizeReapedRunner,
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
import { RunnerSessionGarbageCollectionScheduler } from "./runner_session_gc_scheduler.js";
import { UnreadableRunnerRegistrationHandler } from "./unreadable_runner_registration_handler.js";
export type { RunnerRecoveryCoordinatorOptions } from "./runner_recovery_coordinator_options.js";
/** Owns runner adoption and failure recovery; no domain state is derived here. */
export class RunnerRecoveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private scanInFlight: Promise<void> | undefined;
  private releaseGarbageCollectionFingerprint: string | undefined;
  private readonly recoveryLogger: RunnerRecoveryLogger;
  private readonly hydrationPhase: RunnerRecoveryHydrationPhase;
  private readonly adoptionFailureRecovery: RunnerAdoptionFailureRecovery;
  private readonly sessionGarbageCollectionScheduler: RunnerSessionGarbageCollectionScheduler;
  private readonly unreadableRegistrationHandler: UnreadableRunnerRegistrationHandler;
  private readonly registrationControl: RunnerRegistrationControl;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly options: RunnerRecoveryCoordinatorOptions) {
    this.registrationControl = new RunnerRegistrationControl(options.spawner);
    this.sessionGarbageCollectionScheduler = new RunnerSessionGarbageCollectionScheduler({
      ...(options.sessionGarbageCollector
        ? {
          collector: {
            collect: async (scan) => await options.sessionGarbageCollector!.collect(
              scan,
              {
                centralSessionExists: async (sessionId) =>
                  await options.taskManager.hydrateRunnerRecoveryTask(sessionId) !== null,
              },
            ),
          },
        }
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
      markFailure: async (task, message) =>
        await this.options.taskManager.markRunnerFailure(task, message),
      onFailure: (registration, disposition, error) =>
        this.recoveryLogger.failure(registration, disposition, error),
    });
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
    await this.unreadableRegistrationHandler.handle(scan.errors);
    this.recoveryLogger.prune(scan.registrations);
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
        this.active.has(sessionId)
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
    const recoveryReadiness: Promise<void>[] = [];
    for (const { registration, disposition } of admitted) {
      const sessionId = registration.config.sessionId;
      const outcome = hydrationBySession.get(sessionId);
      if (outcome && outcome.status !== "ready") {
        if (
          outcome.status === "missing"
          && !registration.pidAlive
          && (
            registration.pid === null
            || (
              registration.lifecycle !== null
              && isTerminalRunnerExecutionState(registration.lifecycle.execution_state)
            )
          )
          && registration.pidStartIdentity === null
        ) {
          try {
            await this.registrationControl.retireReleasedTerminal(
              registration,
              async () =>
                await this.options.taskManager.hydrateRunnerRecoveryTask(sessionId) === null,
            );
            registration.retiredAt = new Date(
              (this.options.now ?? Date.now)(),
            ).toISOString();
            this.recoveryLogger.clear(sessionId);
            this.options.logger.info(
              { sessionId },
              "deleted session runner evidence retired after kernel-lock release",
            );
          } catch (error) {
            this.recoveryLogger.failure(registration, disposition, error);
          }
          continue;
        }
        this.recoveryLogger.hydration(outcome);
        continue;
      }
      const task = outcome?.status === "ready" ? outcome.task : undefined;
      let ready = false;
      let resolveReady!: () => void;
      const readiness = new Promise<void>((resolve) => { resolveReady = resolve; });
      const markReady = () => {
        if (ready) return;
        ready = true;
        resolveReady();
      };
      const recovery = this.handleWithFailureTracking(
        registration,
        disposition,
        task,
        markReady,
      )
        .finally(() => {
          markReady();
          if (this.active.get(sessionId) === recovery) this.active.delete(sessionId);
        });
      this.active.set(sessionId, recovery);
      recoveryReadiness.push(readiness);
    }
    await Promise.all(recoveryReadiness);
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
  private async handle(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
    onRunnerAttached?: () => void,
  ): Promise<void> {
    if (
      task
      && disposition === "replay_terminal"
      && await this.options.taskExecutor.retainRegisteredClaudeBackgroundRunner(
        task,
        registration,
      )
    ) {
      this.options.logger.info(
        {
          sessionId: registration.config.sessionId,
          disposition,
          blockedBy: "background",
        },
        "registered runner recovery skipped because SDK background work owns the process",
      );
      return;
    }
    if (disposition === "replay_terminal_dead") {
      await this.terminalizeDeadClaudeBackgroundTasks(registration);
    }
    const recordedTerminal = task && hasRecordedTerminal(task);
    if (
      task
      && recordedTerminal
      && await this.retireAttachedTerminalAdmission(registration, task)
    ) {
      return;
    }
    if (
      task
      && recordedTerminal
      && !task.runner
      && !task.executionPromise
    ) {
      await this.registrationControl.retireTerminal(registration);
      this.options.logger.info(
        { sessionId: registration.config.sessionId },
        "recorded terminal runner registration retired without replay",
      );
      return;
    }
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
        onRunnerAttached,
      );
      return;
    }
    if (disposition === "reap_stalled") {
      await this.recoverByDisposition(
        registration,
        registration.lifecycle ? "adopt_running" : "adopt_prebootstrap",
        requireRecoveryTask(task, registration),
        onRunnerAttached,
      );
      return;
    }
    if (disposition === "reap_dead") {
      await this.terminalizeFailed(
        registration,
        disposition,
        requireRecoveryTask(task, registration),
        onRunnerAttached,
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
          await this.recoverByDisposition(
            hydrated,
            verifiedDisposition,
            recoveredTask,
            onRunnerAttached,
          );
        }
        return;
      }
      if (hydrated.pidAlive) await this.registrationControl.terminate(hydrated);
      const closedRegistration = { ...hydrated, pidAlive: false };
      if (closedRunnerTailRequiresDrain(closedRegistration)) {
        await this.options.closedTailDrainer.drain(closedRegistration);
      }
      prepareRecoveredTask(recoveredTask, closedRegistration);
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
      await terminalizeReapedRunner({
        registration,
        task: requireRecoveryTask(task, registration),
        ...(this.options.hydrate ? { hydrate: this.options.hydrate } : {}),
        terminate: async (owned) => {
          await this.registrationControl.terminate(owned);
        },
        invalidate: async (owned) => await this.registrationControl.invalidate(owned),
        recoverOffline: async (owned, recoveredTask) =>
          (await this.recoverRegistered(
            owned,
            recoveredTask,
            "offline",
            undefined,
            undefined,
            onRunnerAttached,
          )).task,
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
    onRunnerAttached?: () => void,
  ): Promise<void> {
    await handleRecoveryWithFailureTracking({
      registration,
      disposition,
      ...(task ? { task } : {}),
      handle: async (owned, ownedDisposition, recoveredTask) =>
        await this.handle(
          owned,
          ownedDisposition,
          recoveredTask,
          onRunnerAttached,
        ),
      recoveryLogger: this.recoveryLogger,
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
    onRunnerAttached?: () => void,
  ): Promise<{ task: Task; replayed: boolean }> {
    if (
      mode === "offline"
      && task.runner
      && task.executionPromise === undefined
      && task.runner.dispatcher.hasActiveExecution() !== true
      && registrationOwnsAttachedRunner(task, registration)
    ) {
      // A rejected adoption can leave a host handle without ever creating an
      // execution admission. There is no stream or slot to settle in this
      // shape, so only that unattached handle is released before offline replay.
      const unadmitted = task.runner;
      releaseTaskRunner(task, unadmitted);
      await unadmitted.dispatcher.detachHost();
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
      // outage: a settled execution promise left behind by failed startup
      // reads exactly like a live execution, so every later scan
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
        return onRunnerAttached;
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

  private async terminalizeFailed(
    registration: RunnerRegistration,
    disposition: "reap_dead" | "reap_stalled",
    task: Task,
    onRunnerAttached?: () => void,
  ): Promise<void> {
    await terminalizeFailedRunner({
      registration,
      disposition,
      task,
      ...(this.options.hydrate ? { hydrate: this.options.hydrate } : {}),
      now: this.options.now ?? Date.now,
      leaseTimeoutMs: this.options.leaseTimeoutMs,
      recover: async (owned, verified, recoveredTask) =>
        await this.recoverByDisposition(
          owned,
          verified,
          recoveredTask,
          onRunnerAttached,
        ),
      terminalize: async (owned, recoveredTask, error, verified) => {
        if (await this.retireAttachedTerminalAdmission(owned, recoveredTask)) return;
        if (verified === "reap_dead") {
          await this.terminalizeDeadClaudeBackgroundTasks(owned);
        }
        await this.adoptionFailureRecovery.terminalize(
          owned,
          recoveredTask,
          error,
          verified,
        );
      },
    });
  }

  private async terminalizeDeadClaudeBackgroundTasks(
    registration: RunnerRegistration,
  ): Promise<void> {
    const registrationId = registration.registrationId;
    const executionCommandId = registration.lifecycle?.execution_command_id;
    if (!registrationId || !executionCommandId) return;
    await this.options.terminalizeClaudeBackgroundTasks?.(
      registration.config.sessionId,
      { registrationId, executionCommandId },
    );
  }

  private async recoverByDisposition(
    registration: RunnerRegistration,
    disposition: RecoverableRunnerDisposition,
    task: Task,
    onRunnerAttached?: () => void,
  ): Promise<Task> {
    if (
      (disposition === "replay_terminal" || disposition === "replay_terminal_dead")
      && await this.retireAttachedTerminalAdmission(registration, task)
    ) {
      return task;
    }
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
          onRunnerAttached,
        )).task,
      recoverOffline: async (ownedRegistration, ownedTask, prepare) =>
        await this.recoverRegistered(
          ownedRegistration,
          ownedTask,
          "offline",
          prepare,
          undefined,
          onRunnerAttached,
        ),
      terminate: async (ownedRegistration) =>
        await this.registrationControl.terminate(ownedRegistration),
      retireTerminal: async (ownedRegistration) =>
        await this.registrationControl.retireTerminal(ownedRegistration),
      logger: this.options.logger,
    });
  }

  private async retireAttachedTerminalAdmission(
    registration: RunnerRegistration,
    task: Task,
  ): Promise<boolean> {
    const runner = task.runner;
    if (!runner || !registrationOwnsAttachedRunner(task, registration)) return false;
    if (runner.dispatcher.isClosed?.() === true) return false;
    const attachedExecutionCommandId =
      runner.dispatcher.activeExecutionCommandId?.();
    if (task.executionPromise === undefined && attachedExecutionCommandId === undefined) {
      return false;
    }
    const terminalExecutionCommandId = registration.lifecycle?.execution_command_id;
    const terminalOwnsAdmission =
      typeof terminalExecutionCommandId === "string"
      && attachedExecutionCommandId === terminalExecutionCommandId;
    if (
      attachedExecutionCommandId !== undefined
      && terminalExecutionCommandId !== undefined
      && !terminalOwnsAdmission
    ) {
      return false;
    }
    if (runner.dispatcher.hasActiveExecution() === true && !terminalOwnsAdmission) {
      return false;
    }
    const retire = runner.dispatcher.retireTerminalRegistration;
    if (!retire) {
      throw new Error(
        `runner terminal admission retirement unavailable: ${registration.config.sessionId}`,
      );
    }
    const execution = task.executionPromise;
    await retire.call(runner.dispatcher, async () => {
      await execution?.catch(() => undefined);
      if (task.executionPromise === execution && execution !== undefined) {
        throw new Error(
          `runner terminal retirement did not settle execution: ${registration.config.sessionId}`,
        );
      }
      if (!hasRecordedTerminal(task)) {
        throw new Error(
          `runner terminal retirement did not record session terminal: ${registration.config.sessionId}`,
        );
      }
    });
    if (task.runner === runner) releaseTaskRunner(task, runner);
    this.options.logger.info(
      {
        sessionId: registration.config.sessionId,
        runnerDispatcher: runner.dispatcher.dispatcherId?.(),
        attachedExecutionCommandId,
        terminalExecutionCommandId,
      },
      "recorded terminal runner registration retired without replay",
    );
    return true;
  }
}

function hasRecordedTerminal(task: Task): boolean {
  return isTerminalTaskStatus(task.status)
    && task.terminationEventRecorded === true
    && typeof task.terminalEventId === "number"
    && Number.isSafeInteger(task.terminalEventId)
    && task.terminalEventId > 0;
}

function registrationOwnsAttachedRunner(
  task: Task,
  registration: RunnerRegistration,
): boolean {
  const attachedRegistrationId = task.runner?.dispatcher.registrationId();
  return attachedRegistrationId !== undefined
    && registration.registrationId === attachedRegistrationId;
}
