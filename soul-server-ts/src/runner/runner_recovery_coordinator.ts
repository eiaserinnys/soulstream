import { performance } from "node:perf_hooks";
import { isTerminalTaskStatus, type Task } from "../task/task_models.js";
import { releaseTaskRunner } from "../task/task_runner_release.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
  isTerminalRunnerExecutionState,
  readRunnerRegistrationSummary,
  runnerReleaseGcCandidateFingerprint,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import { RunnerRecoveryHydrationPhase } from "./runner_recovery_hydration_phase.js";
import { RunnerRecoveryLogger } from "./runner_recovery_logging.js";
import {
  dispositionRequiresTask,
  heldExecutionSupersedesRegistration,
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
import {
  classifyRunnerCentralLookup,
  registrationAppliedAndTurnRunning,
  terminalRetainedForRegistration,
} from "./runner_central_check.js";
import {
  classifyRunnerAdoptRejection,
  decideRunnerCentralCheck,
  runnerCentralRetryDelayMs,
} from "./state/runner_central_check_decision.js";
import type {
  RunnerAdoptResponse,
  RunnerCentralCheckDecision,
  RunnerCentralLookup,
} from "./state/runner_central_check_machine.js";
import { decideRunnerHandle } from "./state/runner_handle_decision.js";
import type {
  RunnerHandleFacts,
} from "./state/runner_handle_machine.js";
import type {
  RunnerAdoptionApplication,
} from "../task/runner_adoption_rejected_error.js";
import { RunnerAdoptionRejectedError } from "../task/runner_adoption_rejected_error.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";
import type { ClosedRunnerTailDrainer } from "./closed_runner_tail_drainer.js";
import { isClosedClaudeEngineFailure } from "./closed_engine_error.js";
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
import { RunnerRegistrationScanCache } from "./runner_registration_scan_cache.js";
import { createRunnerPhaseObservation, type RunnerPhaseObservation } from "./runner_phase_observation.js";
export type { RunnerRecoveryCoordinatorOptions } from "./runner_recovery_coordinator_options.js";

/** 중앙 확인이 기억하는 직전 잇기 응답과 다음 판정 시각이다. */
interface CentralCheckRetry {
  response: RunnerAdoptResponse;
  attempt: number;
  nextAttemptAtMs: number;
}

/** Owns runner adoption and failure recovery; no domain state is derived here. */
export class RunnerRecoveryCoordinator {
  private readonly scanCache = new RunnerRegistrationScanCache();
  private readonly active = new Map<string, Promise<void>>();
  private readonly centralChecks = new Map<string, Promise<void>>();
  private readonly adoptionSends = new Set<string>();
  /** 시동 잇기의 응답을 기다리는 세션. 응답 뒤 턴이 도는 동안에는 막지 않는다. */
  private readonly adoptionResponseWaits = new Set<string>();
  private readonly reapedSessions = new Set<string>();
  private readonly centralRetry = new Map<string, CentralCheckRetry>();
  private scanInFlight: Promise<void> | undefined;
  private releaseGarbageCollectionFingerprint: string | undefined;
  private releaseGarbageCollectionInFlight = false;
  private readonly recoveryLogger: RunnerRecoveryLogger;
  private readonly hydrationPhase: RunnerRecoveryHydrationPhase;
  private readonly adoptionFailureRecovery: RunnerAdoptionFailureRecovery;
  private readonly sessionGarbageCollectionScheduler: RunnerSessionGarbageCollectionScheduler;
  private readonly unreadableRegistrationHandler: UnreadableRunnerRegistrationHandler;
  private readonly registrationControl: RunnerRegistrationControl;
  private observationSequence = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly options: RunnerRecoveryCoordinatorOptions) {
    // 완료 정산 미결 포트는 등록 은퇴 길이 쓴다. 거둠 경로도 같은 문을 지난다.
    this.registrationControl = new RunnerRegistrationControl(
      options.spawner,
      options.hasPendingRunnerSettlement,
    );
    this.sessionGarbageCollectionScheduler = new RunnerSessionGarbageCollectionScheduler({
      ...(options.sessionGarbageCollector
        ? {
          collector: {
            collect: async (scan, policy, phaseObservation) => await options.sessionGarbageCollector!.collect(
              scan,
              {
                centralSessionExists: async (sessionId) =>
                  await options.taskManager.hydrateRunnerRecoveryTask(sessionId) !== null,
              },
              phaseObservation,
            ),
          },
        }
        : {}),
      logger: options.logger,
      now: options.now ?? Date.now,
      phaseObservationFactory: () => this.createObservation("runner.recovery.sessionGc"),
    });
    this.unreadableRegistrationHandler = new UnreadableRunnerRegistrationHandler({
      stateDirectory: options.stateDirectory,
      logger: options.logger,
      beforeQuarantine: async (failure) => {
        if (!failure.sessionId) return;
        const task = await options.taskManager.hydrateRunnerRecoveryTask(failure.sessionId);
        if (task) {
          await options.taskManager.markRunnerFailure(
            task,
            `Unreadable runner registration quarantined after kernel lock release: ${failure.error.message}`,
          );
        }
      },
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
      refreshRegistration: async (registration) => options.refreshRegistration
        ? await options.refreshRegistration(registration)
        : await readRunnerRegistrationSummary(registration.config.paths.sessionDirectory, {
            verifyProcessIdentity: true,
            ...(options.recoveryStorage ? { recoveryStorage: options.recoveryStorage } : {}),
          }),
      hydrateRegistration: async (registration) => options.hydrate
        ? await options.hydrate(registration)
        : await hydrateRunnerRegistration(registration, undefined, options.recoveryStorage),
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
    const scanId = `${this.options.nodeId}:recovery-scan:${++this.observationSequence}`;
    const observation = this.createObservation("runner.recovery.scan", scanId);
    let scanRegistrations: RunnerRegistration[] = [];
    let admitted: Array<{
      registration: RunnerRegistration;
      disposition: RunnerRecoveryDisposition;
    }> = [];
    try {
      const sessionGcInFlight = this.sessionGarbageCollectionScheduler.inFlight;
      if (sessionGcInFlight) {
        await observation.runAsync("gcWait", {}, async () => await sessionGcInFlight);
      } else {
        observation.runSync("gcWait", {}, () => undefined);
      }
      const scan = await observation.runAsync("registration", {}, async () =>
        await (this.options.scan ?? scanRunnerRegistrations)(
          this.options.stateDirectory,
          {
            cache: this.scanCache,
            phaseObservation: observation,
            ...(this.options.recoveryStorage
              ? { recoveryStorage: this.options.recoveryStorage }
              : {}),
          },
        ));
      scanRegistrations = scan.registrations;
      await observation.runAsync("unreadable", {}, async () => {
        await this.unreadableRegistrationHandler.handle(scan.errors);
        this.recoveryLogger.prune(scan.registrations);
        this.adoptionFailureRecovery.prune(
          scan.registrations.map((registration) => registration.config.sessionId),
        );
      });
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
        if (disposition === "wait_for_bootstrap" || disposition === "retired_terminal") {
          this.recoveryLogger.clear(sessionId);
          continue;
        }
        admitted.push({ registration, disposition });
      }
      // 중앙 확인은 훑기의 가름과 달리 실행을 쥔 세션에도 매 훑기마다 걸린다.
      // 잇기 응답 대기(최대 5분)가 훑기를 막지 않도록 결과를 기다리지 않는다.
      this.pruneCentralState(scan.registrations);
      this.startCentralChecks(scan.registrations);
      const hydrationOutcomes = await observation.runAsync("hydration", {}, async () =>
        await this.hydrationPhase.run(
          admitted.filter(({ disposition }) => dispositionRequiresTask(disposition)),
        ));
      const hydrationBySession = new Map(
        hydrationOutcomes.map((outcome) => [
          outcome.registration.config.sessionId,
          outcome,
        ]),
      );
      await observation.runAsync("recoveryReady", {}, async () => {
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
            observation,
          )
            .finally(() => {
              markReady();
              if (this.active.get(sessionId) === recovery) this.active.delete(sessionId);
            });
          this.active.set(sessionId, recovery);
          recoveryReadiness.push(readiness);
        }
        await Promise.all(recoveryReadiness);
      });
      const releaseFingerprint = runnerReleaseGcCandidateFingerprint(scan);
      const releaseGarbageCollector = this.options.releaseGarbageCollector;
      if (
        releaseGarbageCollector
        && !this.releaseGarbageCollectionInFlight
        && releaseFingerprint !== this.releaseGarbageCollectionFingerprint
      ) {
        // The sweep runs behind the scan and one at a time. The fingerprint is
        // claimed when it starts, so a failed sweep does not repeat for the
        // same candidates on every following scan.
        this.releaseGarbageCollectionFingerprint = releaseFingerprint;
        this.releaseGarbageCollectionInFlight = true;
        const releaseObservation = this.createObservation("runner.recovery.releaseGc");
        void (async () => {
          try {
            await releaseGarbageCollector.collect(scan, releaseObservation);
          } catch (error) {
            this.options.logger.error({ err: error }, "runner release GC failed");
          } finally {
            this.releaseGarbageCollectionInFlight = false;
          }
        })();
      }
      this.sessionGarbageCollectionScheduler.schedule({
        ...scan,
        registrations: scan.registrations.filter(
          (registration) => !this.active.has(registration.config.sessionId),
        ),
      });
      const finishedAt = monotonicNow();
      const phaseDurationsMs = observation.phaseDurationsMs();
      const measuredMs = Object.values(phaseDurationsMs).reduce((sum, duration) => sum + duration, 0);
      phaseDurationsMs.otherMs = Math.max(0, finishedAt - startedAt - measuredMs);
      logRunnerRecoveryScan(
        this.options.logger,
        admitted.map(({ registration }) => registration),
        startedAt,
        finishedAt,
        {
          nodeId: this.options.nodeId,
          scanId,
          phaseDurationsMs,
          database: observation.databaseSummary(),
          databaseAndPhaseDurationsOverlap: true,
          nestedGcTimingOverlapsReleaseGc: true,
        },
      );
    } catch (error) {
      const failure = observation.failureFor(error);
      if (failure) {
        try {
          this.options.logger.warn({
            nodeId: this.options.nodeId,
            scanId,
            durationMs: Math.max(0, monotonicNow() - startedAt),
            registrations: scanRegistrations.length,
            failurePhase: failure.phase,
            failureElapsedMs: failure.elapsedMs,
            phaseDurationsMs: observation.phaseDurationsMs(),
            database: observation.databaseSummary(),
            databaseAndPhaseDurationsOverlap: true,
          }, "runner recovery scan phase failed");
        } catch {
          // Preserve the original scan error if reporting also fails.
        }
      }
      throw error;
    }
  }

  private createObservation(operation: string, scopeId?: string): RunnerPhaseObservation {
    const id = scopeId ?? `${this.options.nodeId}:${operation}:${++this.observationSequence}`;
    const nodeStallMonitor = this.options.nodeStallMonitor;
    return createRunnerPhaseObservation({
      nodeId: this.options.nodeId,
      scopeId: id,
      operation,
      logger: this.options.logger,
      ...(this.options.monotonicNow ? { monotonicNow: this.options.monotonicNow } : {}),
      ...(nodeStallMonitor
        ? { beginRunnerOperation: nodeStallMonitor.beginRunnerOperation.bind(nodeStallMonitor) }
        : {}),
    });
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
      || this.centralChecks.size > 0
    ) {
      await Promise.allSettled([
        ...(this.scanInFlight ? [this.scanInFlight] : []),
        ...this.active.values(),
        ...this.adoptionFailureRecovery.pending(),
        ...this.centralChecks.values(),
      ]);
    }
  }
  private async handle(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
    onRunnerAttached?: () => void,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<void> {
    const facts: RunnerHandleFacts = {
      disposition,
      hasTask: task !== undefined,
      recordedTerminal: task !== undefined && hasRecordedTerminal(task),
      closedEngineTerminal: registration.lifecycle !== null
        && registration.lifecycle.execution_state !== "running"
        && isClosedClaudeEngineFailure(
          registration.config.backend,
          registration.lifecycle.terminal_error,
        ),
      detachedBackground: "not_probed",
      retention: "not_probed",
      attachedTerminal: "not_probed",
      deadBackgroundTerminalized: false,
      hasRunner: task?.runner !== undefined,
      hasExecutionPromise: task?.executionPromise !== undefined,
    };
    // 판정은 state/의 정의가 낸다. 물어봐야 아는 조치는 여기서 실행하고
    // 결과를 사실에 적어 다시 판정한다. 갈래의 내용은 종전과 같다.
    for (;;) {
      const action = decideRunnerHandle(facts);
      switch (action) {
        case "recover_closed_engine_terminal":
          await this.recoverByDisposition(
            registration,
            disposition as RecoverableRunnerDisposition,
            task as Task,
            onRunnerAttached,
            phaseObservation,
          );
          return;
        case "probe_detached_background":
          facts.detachedBackground = await this.options.taskExecutor
            .retainRegisteredDetachedRunner(task as Task, registration)
            ? "retained"
            : "absent";
          continue;
        case "stop_detached_background":
          this.options.logger.info(
            {
              sessionId: registration.config.sessionId,
              disposition,
              blockedBy: "background",
            },
            "registered runner recovery skipped because SDK background work owns the process",
          );
          return;
        case "terminalize_dead_background": {
          const recovered = await this.terminalizeDeadClaudeBackgroundTasks(registration);
          facts.deadBackgroundTerminalized = true;
          if (recovered > 0) await this.notifyDeadRunnerBackgroundStopped(task);
          continue;
        }
        case "probe_expired_retention":
          facts.retention = await this.releaseExpiredRetainedRunner(
            registration,
            task as Task,
          )
            ? "released"
            : "not_released";
          facts.hasRunner = task?.runner !== undefined;
          facts.hasExecutionPromise = task?.executionPromise !== undefined;
          continue;
        case "stop_released_retention":
          return;
        case "probe_attached_terminal":
          facts.attachedTerminal = await this.retireAttachedTerminalAdmission(
            registration,
            task as Task,
          )
            ? "retired"
            : "open";
          facts.hasRunner = task?.runner !== undefined;
          facts.hasExecutionPromise = task?.executionPromise !== undefined;
          continue;
        case "stop_retired_attached_terminal":
          return;
        case "retire_recorded_terminal":
          await this.registrationControl.retireTerminal(registration);
          this.options.logger.info(
            { sessionId: registration.config.sessionId },
            "recorded terminal runner registration retired without replay",
          );
          return;
        case "recover_by_disposition":
          await this.recoverByDisposition(
            registration,
            disposition as RecoverableRunnerDisposition,
            requireRecoveryTask(task, registration),
            onRunnerAttached,
            phaseObservation,
          );
          return;
        case "terminalize_failed":
          await this.terminalizeFailed(
            registration,
            disposition as "reap_dead",
            requireRecoveryTask(task, registration),
            onRunnerAttached,
            phaseObservation,
          );
          return;
        case "recover_closed":
          await this.recoverClosed(
            registration,
            task,
            onRunnerAttached,
            phaseObservation,
          );
          return;
        case "terminalize_reaped":
          await this.terminalizeReaped(
            registration,
            task,
            onRunnerAttached,
            phaseObservation,
          );
          return;
        case "unsupported":
          throw new Error(`unsupported runner recovery disposition: ${disposition}`);
      }
    }
  }

  private async recoverClosed(
    registration: RunnerRegistration,
    task: Task | undefined,
    onRunnerAttached?: () => void,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<void> {
    const recoveredTask = requireRecoveryTask(task, registration);
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(
      registration,
      phaseObservation,
      this.options.recoveryStorage,
    );
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
          phaseObservation,
        );
      }
      return;
    }
    if (heldExecutionSupersedesRegistration(recoveredTask, hydrated)) {
      this.options.logger.info(
        { sessionId: hydrated.config.sessionId, disposition: "closed" },
        "closed runner recovery skipped because a newer execution owns the session",
      );
      return;
    }
    if (hydrated.pidAlive) await this.registrationControl.terminate(hydrated);
    const closedRegistration = { ...hydrated, pidAlive: false };
    if (closedRunnerTailRequiresDrain(closedRegistration)) {
      await this.options.closedTailDrainer.drain(closedRegistration, phaseObservation);
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
  }

  private async terminalizeReaped(
    registration: RunnerRegistration,
    task: Task | undefined,
    onRunnerAttached?: () => void,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<void> {
    const recoveryTask = requireRecoveryTask(task, registration);
    await terminalizeReapedRunner({
      registration,
      task: recoveryTask,
      hydrate: (owned) => (this.options.hydrate ?? hydrateRunnerRegistration)(
        owned,
        phaseObservation,
        this.options.recoveryStorage,
      ),
      terminate: async (owned) => {
        await this.registrationControl.terminate(owned);
      },
      invalidate: async (owned) => await this.registrationControl.invalidate(owned),
      retireAttached: async (owned) =>
        await this.retireAttachedTerminalAdmission(owned, recoveryTask),
      recoverOffline: async (owned, recoveredTask) =>
        (await this.recoverRegistered(
          owned,
          recoveredTask,
          "offline",
          undefined,
          undefined,
          onRunnerAttached,
          phaseObservation,
        )).task,
      logger: this.options.logger,
    });
  }

  private async handleWithFailureTracking(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
    onRunnerAttached?: () => void,
    phaseObservation?: RunnerPhaseObservation,
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
          phaseObservation,
        ),
      recoveryLogger: this.recoveryLogger,
    });
  }

  /** 사라진 등록의 중앙 확인 상태를 버린다. */
  private pruneCentralState(registrations: RunnerRegistration[]): void {
    const live = new Set(
      registrations.map((registration) => registration.config.sessionId),
    );
    for (const sessionId of this.centralRetry.keys()) {
      if (!live.has(sessionId)) this.centralRetry.delete(sessionId);
    }
    for (const sessionId of this.reapedSessions) {
      if (!live.has(sessionId)) this.reapedSessions.delete(sessionId);
    }
  }

  /**
   * 실행을 쥔 세션의 러너를 중앙 세션과 대조한다.
   *
   * 확인과 잇기는 훑기를 막지 않도록 결과를 기다리지 않고 세션마다 하나씩 돈다.
   * 같은 세션에 시동 복구(잇기)나 잇기 실패 복구, 중앙 확인이 이미 돌고 있으면
   * 새로 시작하지 않는다.
   */
  private startCentralChecks(registrations: RunnerRegistration[]): void {
    if (this.options.readCentralSession === undefined) return;
    const listTasks = this.options.taskManager.listTasks;
    if (listTasks === undefined) return;
    const tasksBySession = new Map(
      listTasks
        .call(this.options.taskManager)
        .map((task) => [task.agentSessionId, task]),
    );
    const nowMs = (this.options.now ?? Date.now)();
    for (const registration of registrations) {
      const sessionId = registration.config.sessionId;
      const task = tasksBySession.get(sessionId);
      if (!task) continue;
      if (!task.runner && !task.executionPromise) continue;
      if (this.centralChecks.has(sessionId)) continue;
      if (this.adoptionSends.has(sessionId)) continue;
      if (this.adoptionResponseWaits.has(sessionId)) continue;
      if (this.adoptionFailureRecovery.has(sessionId)) continue;
      if (this.reapedSessions.has(sessionId)) continue;
      const retry = this.centralRetry.get(sessionId);
      if (retry && nowMs < retry.nextAttemptAtMs) continue;
      this.runCentralCheck(registration, task);
    }
  }

  private runCentralCheck(registration: RunnerRegistration, task: Task): void {
    const sessionId = registration.config.sessionId;
    const readCentralSession = this.options.readCentralSession;
    if (!readCentralSession) return;
    const check = (async () => {
      let lookup: RunnerCentralLookup;
      try {
        lookup = classifyRunnerCentralLookup(
          await readCentralSession(sessionId),
          this.options.nodeId,
        );
      } catch (error) {
        this.options.logger.warn(
          { err: error, sessionId },
          "runner central session lookup failed",
        );
        lookup = "lookup_error";
      }
      const nowMs = (this.options.now ?? Date.now)();
      const decision = this.decideCentralCheck(
        sessionId,
        task,
        registration,
        lookup,
        nowMs,
      );
      switch (decision) {
        case "reap":
          await this.reapSession(registration, task, lookup);
          return;
        case "adopt":
          await this.sendCentralAdoption(registration, task);
          return;
        case "keep":
          if (lookup === "active") {
            // 활성을 보면 다시 판정 간격을 처음으로 되돌린다.
            this.centralRetry.delete(sessionId);
          }
          return;
        case "keep_retry":
          // 받아 둔 거절의 다음 판정 시각은 이미 적혀 있다.
          return;
      }
    })();
    this.centralChecks.set(sessionId, check);
    void check
      .catch((error) => {
        this.options.logger.warn(
          { err: error, sessionId },
          "runner central check failed",
        );
      })
      .finally(() => {
        if (this.centralChecks.get(sessionId) === check) {
          this.centralChecks.delete(sessionId);
        }
      });
  }

  private decideCentralCheck(
    sessionId: string,
    task: Task,
    registration: RunnerRegistration,
    lookup: RunnerCentralLookup,
    nowMs: number,
  ): RunnerCentralCheckDecision {
    const retry = this.centralRetry.get(sessionId);
    if (
      retry
      && retry.response === "retryable_rejection"
      && nowMs >= retry.nextAttemptAtMs
    ) {
      // 다시 될 수 있는 거절의 간격이 지났다. 받아 둔 응답을 지우고 새로
      // 판정한다. 이 판정이 잇기를 고르면 새 시도 UUID로 다시 보낸다.
      this.centralRetry.set(sessionId, {
        response: "none",
        attempt: retry.attempt,
        nextAttemptAtMs: 0,
      });
    }
    return decideRunnerCentralCheck({
      lookup,
      terminalRetained: terminalRetainedForRegistration(task, registration),
      registrationAppliedAndTurnRunning: registrationAppliedAndTurnRunning(
        task,
        registration,
      ),
      adoptResponse: this.centralRetry.get(sessionId)?.response ?? "none",
    });
  }

  /** 잇기 전이의 응답을 적는다. 적용과 활성은 간격을 처음으로 되돌린다. */
  private recordCentralAdoptionResponse(
    sessionId: string,
    application: RunnerAdoptionApplication,
  ): void {
    if (application.applied) {
      this.centralRetry.delete(sessionId);
      return;
    }
    const response = classifyRunnerAdoptRejection(application.rejectionReason);
    if (response === "terminal_rejection") {
      // 다음 훑기의 중앙 확인이 거둔다.
      this.centralRetry.set(sessionId, {
        response,
        attempt: 0,
        nextAttemptAtMs: 0,
      });
      return;
    }
    const attempt = (this.centralRetry.get(sessionId)?.attempt ?? 0) + 1;
    const nextAttemptAtMs = (this.options.now ?? Date.now)()
      + runnerCentralRetryDelayMs(attempt);
    this.centralRetry.set(sessionId, { response, attempt, nextAttemptAtMs });
    this.options.logger.info(
      {
        sessionId,
        rejectionReason: application.rejectionReason ?? null,
        attempt,
        retryAt: new Date(nextAttemptAtMs).toISOString(),
      },
      "runner adoption rejected with a retryable reason; runner kept for a later central check",
    );
  }

  /** 이미 붙은 러너에 잇기 전이만 보낸다. 러너를 다시 붙이지 않는다. */
  private async sendCentralAdoption(
    registration: RunnerRegistration,
    task: Task,
  ): Promise<void> {
    const sessionId = registration.config.sessionId;
    const adopt = this.options.taskExecutor.adoptAttachedRunnerExecution;
    if (!adopt) return;
    this.adoptionSends.add(sessionId);
    try {
      const application = await adopt.call(
        this.options.taskExecutor,
        task,
        registration.lifecycle?.execution_command_id,
      );
      this.recordCentralAdoptionResponse(sessionId, application);
    } catch (error) {
      // 거절이 아닌 전송 실패는 이 길이 아니다. 다음 훑기에서 다시 본다.
      this.options.logger.warn(
        { err: error, sessionId },
        "central runner adoption send failed",
      );
    } finally {
      this.adoptionSends.delete(sessionId);
    }
  }

  /**
   * 중앙에 없는 실행을 거둔다.
   *
   * 턴을 멈추고, 등록 은퇴 길로 러너 프로세스를 종료하고 등록을 은퇴시키고,
   * 메모리의 task를 내린다. 완료 전달은 등록하지 않는다. 수신자 칸을 먼저
   * 비워, 거둔 뒤 도착하는 실행 끝남이 완료 전달로 이어지지 않게 한다.
   */
  private async reapSession(
    registration: RunnerRegistration,
    task: Task,
    lookup: RunnerCentralLookup,
  ): Promise<void> {
    const sessionId = registration.config.sessionId;
    // 완료 정산 미결이면 은퇴하지 않는다. 프로세스를 건드리기 전에 묻는다.
    await this.registrationControl.assertNoPendingSettlement(registration);
    this.reapedSessions.add(sessionId);
    this.centralRetry.delete(sessionId);
    task.callerSessionId = undefined;
    const runner = task.runner !== undefined
      && registrationOwnsAttachedRunner(task, registration)
      ? task.runner
      : undefined;
    try {
      if (runner && typeof runner.dispatcher.interrupt === "function") {
        await runner.dispatcher.interrupt();
      }
    } catch (error) {
      this.options.logger.warn(
        { err: error, sessionId },
        "reaped runner turn interrupt failed",
      );
    }
    try {
      // 은퇴 길이 기록된 신원의 프로세스를 정확히 종료한다.
      await this.registrationControl.retireTerminal(registration);
    } catch (error) {
      this.reapedSessions.delete(sessionId);
      throw error;
    }
    if (runner) {
      try {
        await runner.dispatcher.detachHost();
      } catch (error) {
        this.options.logger.warn(
          { err: error, sessionId },
          "reaped runner host detach failed",
        );
      }
      releaseTaskRunner(task, runner);
    }
    this.adoptionFailureRecovery.clear(sessionId);
    this.options.taskManager.forgetRunnerRecoveryTask?.(sessionId);
    this.options.logger.info(
      {
        sessionId,
        lookup,
        executionState: registration.lifecycle?.execution_state ?? null,
      },
      "runner reaped because the central session no longer carries this execution",
    );
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
    phaseObservation?: RunnerPhaseObservation,
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
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(
      registration,
      phaseObservation,
      this.options.recoveryStorage,
    );
    const lifecycle = hydrated.lifecycle;
    const sessionId = registration.config.sessionId;
    prepareRecoveredTask(task, hydrated);
    let attemptRunner: TaskRunnerRuntime | undefined;
    let adoptionAnswered = false;
    const recoveryCall = [
      task,
      hydrated,
      lifecycle?.execution_command_id,
      mode,
      (runner: TaskRunnerRuntime) => {
        attemptRunner = runner;
        return onRunnerAttached;
      },
      phaseObservation,
    ] as const;
    let completion: Promise<void>;
    try {
      if (mode === "adopt" && adoptionDisposition) {
        // 응답을 기다리는 동안만 중앙 확인을 막는다. 응답을 받은 뒤 이 턴이
        // 끝날 때까지 기다리는 것은 잇기가 아니라 실행이므로 막지 않는다.
        this.adoptionResponseWaits.add(sessionId);
      }
      completion = mode === "adopt"
        ? this.options.taskExecutor.recoverRegisteredRunner(
            ...recoveryCall,
            (application?: RunnerAdoptionApplication) => {
              if (application === undefined) return;
              adoptionAnswered = true;
              this.adoptionResponseWaits.delete(sessionId);
              this.recordCentralAdoptionResponse(sessionId, application);
            },
          )
        : this.options.taskExecutor.recoverRegisteredRunner(...recoveryCall);
    } catch (error) {
      this.adoptionResponseWaits.delete(sessionId);
      throw error;
    }
    const ownedRunner = task.runner;
    if (mode === "offline") {
      await completion;
    } else if (mode === "adopt" && adoptionDisposition) {
      try {
        try {
          await completion;
          this.adoptionFailureRecovery.clear(sessionId);
        } catch (error) {
          // 잇기 거절은 응답이지 실패가 아니다. 러너를 붙인 채 두고 중앙 확인이
          // 간격 뒤 다시 판정한다. 거절이 아닌 잇기 실패만 A가 맡는다.
          if (error instanceof RunnerAdoptionRejectedError) {
            if (!adoptionAnswered) {
              this.recordCentralAdoptionResponse(sessionId, {
                applied: false,
                rejectionReason: error.rejectionReason,
              });
            }
            this.options.logger.info(
              { sessionId, rejectionReason: error.reason, mode },
              "startup runner adoption rejected; runner kept attached for a later central check",
            );
            return { task, replayed: false };
          }
          if (this.reapedSessions.has(sessionId)) {
            this.options.logger.info(
              { sessionId, mode },
              "startup runner adoption failure ignored because the session runner was reaped",
            );
            return { task, replayed: false };
          }
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
      } finally {
        this.adoptionResponseWaits.delete(sessionId);
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
    disposition: "reap_dead",
    task: Task,
    onRunnerAttached?: () => void,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<void> {
    await terminalizeFailedRunner({
      registration,
      disposition,
      task,
      hydrate: (owned) => (this.options.hydrate ?? hydrateRunnerRegistration)(
        owned,
        phaseObservation,
        this.options.recoveryStorage,
      ),
      now: this.options.now ?? Date.now,
      leaseTimeoutMs: this.options.leaseTimeoutMs,
      recover: async (owned, verified, recoveredTask) =>
        await this.recoverByDisposition(
          owned,
          verified,
          recoveredTask,
          onRunnerAttached,
          phaseObservation,
        ),
      terminalize: async (owned, recoveredTask, error, verified) => {
        if (await this.retireAttachedTerminalAdmission(owned, recoveredTask)) return;
        // 이미 종료 확정인 task는 markFailure가 아무것도 보내지 않는다. 그
        // 경우에만 러너 죽음의 멈춤을 따로 알린다 — 아니면 실패 결과와 겹친다.
        const alreadyTerminal = isTerminalTaskStatus(recoveredTask.status);
        let recovered = 0;
        if (verified === "reap_dead") {
          recovered = await this.terminalizeDeadClaudeBackgroundTasks(owned);
        }
        await this.adoptionFailureRecovery.terminalize(
          owned,
          recoveredTask,
          error,
          verified,
        );
        if (recovered > 0 && alreadyTerminal) {
          await this.notifyDeadRunnerBackgroundStopped(recoveredTask);
        }
      },
    });
  }

  private async terminalizeDeadClaudeBackgroundTasks(
    registration: RunnerRegistration,
  ): Promise<number> {
    const registrationId = registration.registrationId;
    const executionCommandId = registration.lifecycle?.execution_command_id;
    if (!registrationId || !executionCommandId) return 0;
    return await this.options.terminalizeClaudeBackgroundTasks?.(
      registration.config.sessionId,
      { registrationId, executionCommandId },
    ) ?? 0;
  }

  private async notifyDeadRunnerBackgroundStopped(task: Task | undefined): Promise<void> {
    const notify = this.options.notifyDeadRunnerBackgroundStopped;
    if (!notify || !task) return;
    try {
      await notify(task);
    } catch (error) {
      this.options.logger.warn(
        { err: error, sessionId: task.agentSessionId },
        "dead runner background stopped notice failed",
      );
    }
  }

  private async recoverByDisposition(
    registration: RunnerRegistration,
    disposition: RecoverableRunnerDisposition,
    task: Task,
    onRunnerAttached?: () => void,
    phaseObservation?: RunnerPhaseObservation,
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
          phaseObservation,
        )).task,
      recoverOffline: async (ownedRegistration, ownedTask, prepare) =>
        await this.recoverRegistered(
          ownedRegistration,
          ownedTask,
          "offline",
          prepare,
          undefined,
          onRunnerAttached,
          phaseObservation,
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

  private async releaseExpiredRetainedRunner(
    registration: RunnerRegistration,
    task: Task,
  ): Promise<boolean> {
    const release = await this.options.taskExecutor.releaseExpiredRetainedRunner(
      task,
      registration,
      true,
    );
    if (release === "not_released") return false;
    if (release === "retry_required") {
      await this.registrationControl.terminate(registration);
    }
    const claim = task.runnerReleaseClaim;
    if (
      !claim
      || claim.registrationId !== registration.registrationId
      || task.runner !== claim.runner
      || !hasRecordedTerminal(task)
    ) {
      throw new Error(
        `retained runner claim changed before retirement: ${registration.config.sessionId}`,
      );
    }
    await this.registrationControl.retireTerminal({
      ...registration,
      pid: null,
      pidAlive: false,
      pidStartIdentity: null,
    });
    if (
      !this.options.taskExecutor.completeRetainedRunnerReleaseAfterTermination(
        task,
        registration,
      )
    ) {
      throw new Error(
        `retired retained runner claim changed: ${registration.config.sessionId}`,
      );
    }
    this.options.logger.info(
      { sessionId: registration.config.sessionId },
      "expired detached-command runner released and terminal registration retired",
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
