import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { Task } from "../task/task_models.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
  runnerReleaseGcCandidateFingerprint,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import { unreadableRegistrationFingerprint } from "./runner_recovery_fingerprint.js";
import { RunnerRecoveryHydrationPhase } from "./runner_recovery_hydration_phase.js";
import { RunnerRecoveryLogger } from "./runner_recovery_logging.js";
import {
  markRegistrationReaped,
  prepareRecoveredTask,
  requireRecoveryTask,
} from "./runner_recovery_task.js";
import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import {
  quarantineUnreadableRunnerRegistration,
  type RunnerRegistrationQuarantineResult,
} from "./runner_registration_quarantine.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";
import type { RunnerSessionGarbageCollector } from "./runner_session_gc.js";
import type { ClosedRunnerTailDrainer } from "./closed_runner_tail_drainer.js";
import {
  closedRunnerTailRequiresDrain,
  logRunnerRecoveryScan,
} from "./runner_recovery_scan_observer.js";
const RUNNER_SESSION_GC_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
export interface RunnerRecoveryCoordinatorOptions {
  stateDirectory: string;
  leaseTimeoutMs: number;
  scanIntervalMs: number;
  taskManager: Pick<
    TaskManager,
    "hydrateRunnerRecoveryTask" | "markRunnerFailureAndResume"
  >;
  taskExecutor: Pick<
    TaskExecutor,
    "recoverRegisteredRunner" | "restartRegisteredRunner"
  >;
  closedTailDrainer: Pick<ClosedRunnerTailDrainer, "drain">;
  logger: Pick<Logger, "error" | "info" | "warn">;
  spawner?: Pick<RunnerProcessSpawner, "terminate">;
  scan?: typeof scanRunnerRegistrations;
  hydrate?: typeof hydrateRunnerRegistration;
  now?: () => number;
  monotonicNow?: () => number;
  markReaped?: (
    registration: RunnerRegistration,
    progressedAt: string,
    error: { code: string; message: string },
  ) => Promise<void>;
  releaseGarbageCollector?: Pick<RunnerReleaseGarbageCollector, "collect">;
  sessionGarbageCollector?: Pick<RunnerSessionGarbageCollector, "collect">;
  quarantineFailure?: typeof quarantineUnreadableRunnerRegistration;
  hydrationDeadlineMs?: number;
  hydrationConcurrency?: number;
}
/** Owns runner adoption and failure recovery; no domain state is derived here. */
export class RunnerRecoveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private scanInFlight: Promise<void> | undefined;
  private releaseGarbageCollectionFingerprint: string | undefined;
  private readonly unreadableRegistrationFingerprints = new Map<string, string>();
  private readonly recoveryLogger: RunnerRecoveryLogger;
  private readonly hydrationPhase: RunnerRecoveryHydrationPhase;
  private sessionGarbageCollectionInFlight: Promise<void> | undefined;
  private nextSessionGarbageCollectionAtMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly options: RunnerRecoveryCoordinatorOptions) {
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
    if (this.sessionGarbageCollectionInFlight) {
      await this.sessionGarbageCollectionInFlight;
    }
    const scan = await (this.options.scan ?? scanRunnerRegistrations)(
      this.options.stateDirectory,
    );
    await this.handleUnreadableRegistrations(scan.errors);
    this.recoveryLogger.prune(scan.registrations);
    const admitted: Array<{
      registration: RunnerRegistration;
      disposition: RunnerRecoveryDisposition;
    }> = [];
    for (const registration of scan.registrations) {
      const sessionId = registration.config.sessionId;
      if (this.active.has(sessionId)) continue;
      const disposition = classifyRunnerRegistration(
        registration,
        (this.options.now ?? Date.now)(),
        this.options.leaseTimeoutMs,
      );
      if (
        disposition === "wait_for_bootstrap"
      ) {
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
    for (const { registration, disposition } of admitted) {
      const sessionId = registration.config.sessionId;
      const outcome = hydrationBySession.get(sessionId);
      if (outcome && outcome.status !== "ready") {
        this.recoveryLogger.hydration(outcome);
        continue;
      }
      const task = outcome?.status === "ready" ? outcome.task : undefined;
      if (
        disposition === "adopt_prebootstrap"
        || disposition === "adopt_running"
        || (disposition === "replay_terminal" && registration.pidAlive)
      ) {
        await this.handleWithFailureTracking(registration, disposition, task);
        continue;
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
    this.scheduleSessionGarbageCollection({
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
  private async handleUnreadableRegistrations(
    failures: Array<{ directory: string; error: Error; sessionId?: string; codeSha?: string }>,
  ): Promise<void> {
    const currentDirectories = new Set(failures.map((failure) => failure.directory));
    for (const directory of this.unreadableRegistrationFingerprints.keys()) {
      if (!currentDirectories.has(directory)) {
        this.unreadableRegistrationFingerprints.delete(directory);
      }
    }
    for (const failure of failures) {
      const fingerprint = unreadableRegistrationFingerprint(failure);
      const shouldLog = this.unreadableRegistrationFingerprints.get(failure.directory)
        !== fingerprint;
      if (shouldLog) {
        const { error, ...failureContext } = failure;
        this.options.logger.error(
          { ...failureContext, err: error },
          "runner registration is unreadable",
        );
        this.unreadableRegistrationFingerprints.set(failure.directory, fingerprint);
      }
      let result: RunnerRegistrationQuarantineResult;
      try {
        result = await (
          this.options.quarantineFailure ?? quarantineUnreadableRunnerRegistration
        )(this.options.stateDirectory, failure);
      } catch (error) {
        if (shouldLog) {
          this.options.logger.error(
            { err: error, directory: failure.directory, sessionId: failure.sessionId },
            "runner registration quarantine failed",
          );
        }
        continue;
      }
      if (result.status === "quarantined") {
        this.options.logger.info(
          {
            directory: failure.directory,
            quarantinePath: result.path,
            pid: result.pid,
            sessionId: failure.sessionId,
          },
          "proven-dead unreadable runner registration quarantined",
        );
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.waitForSettled();
    await this.sessionGarbageCollectionInFlight;
    this.active.clear();
  }
  /** Waits for recovery work already admitted by a scan without stopping the coordinator. */
  async waitForSettled(): Promise<void> {
    while (this.scanInFlight || this.active.size > 0) {
      await Promise.allSettled([
        ...(this.scanInFlight ? [this.scanInFlight] : []),
        ...this.active.values(),
      ]);
    }
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
      if (registration.pidAlive) await this.terminateRegistration(registration);
      if (!closedRunnerTailRequiresDrain(registration)) return;
      await this.options.closedTailDrainer.drain({ ...registration, pidAlive: false });
      return;
    }
    if (disposition === "already_reaped") {
      await this.resumeReaped(registration, requireRecoveryTask(task, registration));
      return;
    }
    throw new Error(`unsupported runner recovery disposition: ${disposition}`);
  }

  private scheduleSessionGarbageCollection(
    scan: Awaited<ReturnType<typeof scanRunnerRegistrations>>,
  ): void {
    if (
      !this.options.sessionGarbageCollector
      || this.sessionGarbageCollectionInFlight
      || (scan.registrations.length === 0 && scan.errors.length === 0)
    ) return;
    const now = (this.options.now ?? Date.now)();
    if (now < this.nextSessionGarbageCollectionAtMs) return;
    this.nextSessionGarbageCollectionAtMs = now + RUNNER_SESSION_GC_SWEEP_INTERVAL_MS;
    const collection = this.options.sessionGarbageCollector.collect(scan)
      .then(() => undefined)
      .catch((error) => {
        this.nextSessionGarbageCollectionAtMs = 0;
        this.options.logger.error({ err: error }, "runner session GC failed");
      })
      .finally(() => {
        if (this.sessionGarbageCollectionInFlight === collection) {
          this.sessionGarbageCollectionInFlight = undefined;
        }
      });
    this.sessionGarbageCollectionInFlight = collection;
  }

  private async handleWithFailureTracking(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
  ): Promise<void> {
    try {
      await this.handle(registration, disposition, task);
      this.recoveryLogger.clear(registration.config.sessionId);
    } catch (error) {
      this.recoveryLogger.failure(registration, disposition, error);
    }
  }

  private async recoverRegistered(
    registration: RunnerRegistration,
    task: Task,
    mode: "adopt" | "replay" | "offline",
    prepareRegistrationAfterTaskGuard?: (
      registration: RunnerRegistration,
    ) => Promise<RunnerRegistration>,
  ): Promise<Task> {
    if (task.runner || task.executionPromise) return task;
    if (prepareRegistrationAfterTaskGuard) {
      registration = await prepareRegistrationAfterTaskGuard(registration);
    }
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(registration);
    const lifecycle = hydrated.lifecycle;
    prepareRecoveredTask(task, hydrated);
    const completion = this.options.taskExecutor.recoverRegisteredRunner(
      task,
      hydrated.config,
      lifecycle?.execution_command_id,
      mode,
    );
    if (mode === "offline") {
      await completion;
    } else {
      void completion.catch((error) => {
        this.options.logger.error(
          { err: error, sessionId: registration.config.sessionId },
          "live runner host consumption failed",
        );
      });
    }
    return task;
  }

  private async reapAndResume(
    registration: RunnerRegistration,
    disposition: "reap_dead" | "reap_stalled",
    task: Task,
  ): Promise<void> {
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(registration);
    const verifiedDisposition = classifyRunnerRegistration(
      hydrated,
      (this.options.now ?? Date.now)(),
      this.options.leaseTimeoutMs,
    );
    if (verifiedDisposition !== disposition) {
      if (
        verifiedDisposition === "adopt_prebootstrap"
        || verifiedDisposition === "adopt_running"
        || verifiedDisposition === "replay_terminal"
      ) {
        await this.recoverByDisposition(hydrated, verifiedDisposition, task);
      }
      return;
    }
    registration = hydrated;
    const message = disposition === "reap_stalled"
      ? "runner progress lease expired"
      : "runner process exited before execution completed";
    const error = {
      code: disposition === "reap_stalled" ? "lease_expired" : "runner_exited",
      message,
    };
    if (registration.pidAlive) {
      await this.terminateRegistration(registration);
      registration = { ...registration, pidAlive: false };
    }
    if (registration.lifecycle) {
      const progressedAt = new Date((this.options.now ?? Date.now)()).toISOString();
      if (this.options.markReaped) {
        await this.options.markReaped(registration, progressedAt, error);
      } else {
        await markRegistrationReaped(registration, progressedAt, error, this.options.logger);
      }
    }
    const recoveredTask = registration.lifecycle
      ? await this.recoverRegistered({
          ...registration,
          pidAlive: false,
          lifecycle: {
            ...registration.lifecycle,
            execution_state: "reaped",
            terminal_error: error,
          },
        }, task, "offline")
      : task;
    prepareRecoveredTask(recoveredTask, registration);
    await this.options.taskManager.markRunnerFailureAndResume(
      recoveredTask,
      message,
      (resumedTask) => this.options.taskExecutor.restartRegisteredRunner(
        resumedTask,
        registration.config,
      ),
    );
    this.options.logger.info(
      { sessionId: registration.config.sessionId, disposition },
      "runner failure drained and auto-resumed",
    );
  }

  private async resumeReaped(
    registration: RunnerRegistration,
    task: Task,
  ): Promise<void> {
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(registration);
    if (hydrated.pidAlive) await this.terminateRegistration(hydrated);
    await this.recoverRegistered({ ...hydrated, pidAlive: false }, task, "offline");
    prepareRecoveredTask(task, hydrated);
    const message = hydrated.lifecycle?.terminal_error?.message
      ?? "runner was reaped before recovery completed";
    await this.options.taskManager.markRunnerFailureAndResume(
      task,
      message,
      (resumedTask) => this.options.taskExecutor.restartRegisteredRunner(
        resumedTask,
        hydrated.config,
      ),
    );
    this.options.logger.info(
      { sessionId: hydrated.config.sessionId, disposition: "already_reaped" },
      "reaped runner recovery resumed",
    );
  }

  private async recoverByDisposition(
    registration: RunnerRegistration,
    disposition: "adopt_prebootstrap" | "adopt_running" | "replay_terminal",
    task: Task,
  ): Promise<Task> {
    if (disposition !== "replay_terminal") {
      return await this.recoverRegistered(registration, task, "adopt");
    }
    if (
      registration.pidAlive
      && registration.lifecycle?.execution_state === "completed"
    ) {
      return await this.recoverRegistered(registration, task, "replay");
    }
    return await this.recoverRegistered(
      registration,
      task,
      "offline",
      async (guardedRegistration) => {
        if (!guardedRegistration.pidAlive) return guardedRegistration;
        await this.terminateRegistration(guardedRegistration);
        return { ...guardedRegistration, pidAlive: false };
      },
    );
  }

  private async terminateRegistration(registration: RunnerRegistration): Promise<void> {
    if (registration.pid === null || !registration.pidStartIdentity) {
      throw new Error(
        `runner process identity unavailable before termination: ${registration.config.sessionId}`,
      );
    }
    await (this.options.spawner ?? new RunnerProcessSpawner()).terminate(
      registration.config.paths,
      { pid: registration.pid, startIdentity: registration.pidStartIdentity },
    );
  }
}

function dispositionRequiresTask(disposition: RunnerRecoveryDisposition): boolean {
  return disposition !== "wait_for_bootstrap" && disposition !== "closed";
}
