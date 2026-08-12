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
import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import { RunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";
import type { RunnerSessionGarbageCollector } from "./runner_session_gc.js";
import type { ClosedRunnerTailDrainer } from "./closed_runner_tail_drainer.js";

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
  markReaped?: (
    registration: RunnerRegistration,
    progressedAt: string,
    error: { code: string; message: string },
  ) => Promise<void>;
  releaseGarbageCollector?: Pick<RunnerReleaseGarbageCollector, "collect">;
  sessionGarbageCollector?: Pick<RunnerSessionGarbageCollector, "collect">;
}

/** Owns runner adoption and failure recovery; no domain state is derived here. */
export class RunnerRecoveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private scanInFlight: Promise<void> | undefined;
  private releaseGarbageCollectionFingerprint: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly options: RunnerRecoveryCoordinatorOptions) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.scanOnce();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error) => {
        this.options.logger.error({ error }, "runner recovery scan failed");
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
    const scan = await (this.options.scan ?? scanRunnerRegistrations)(
      this.options.stateDirectory,
    );
    for (const failure of scan.errors) {
      this.options.logger.error(failure, "runner registration is unreadable");
    }
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
      ) continue;
      if (
        disposition === "adopt_prebootstrap"
        || disposition === "adopt_running"
        || (disposition === "replay_terminal" && registration.pidAlive)
      ) {
        await this.handle(registration, disposition).catch((error) => {
          this.logRecoveryFailure(registration, disposition, error);
        });
        continue;
      }
      const recovery = this.handle(registration, disposition)
        .catch((error) => {
          this.logRecoveryFailure(registration, disposition, error);
        })
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
        this.options.logger.error({ error }, "runner release GC failed");
      }
    }
    if (this.options.sessionGarbageCollector) {
      try {
        await this.options.sessionGarbageCollector.collect(scan);
      } catch (error) {
        this.options.logger.error({ error }, "runner session GC failed");
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.waitForSettled();
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
  ): Promise<void> {
    if (
      disposition === "adopt_prebootstrap"
      || disposition === "adopt_running"
      || disposition === "replay_terminal"
    ) {
      await this.recoverRegistered(
        registration,
        registration.pidAlive ? "adopt" : "offline",
      );
      return;
    }
    if (disposition === "reap_dead" || disposition === "reap_stalled") {
      await this.reapAndResume(registration, disposition);
      return;
    }
    if (disposition === "closed") {
      if (registration.pidAlive) await this.terminateRegistration(registration);
      await this.options.closedTailDrainer.drain({ ...registration, pidAlive: false });
      return;
    }
    if (disposition === "already_reaped") {
      await this.resumeReaped(registration);
      return;
    }
    throw new Error(`unsupported runner recovery disposition: ${disposition}`);
  }

  private logRecoveryFailure(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    error: unknown,
  ): void {
    this.options.logger.error(
      { error, sessionId: registration.config.sessionId, disposition },
      "runner recovery action failed",
    );
  }

  private async recoverRegistered(
    registration: RunnerRegistration,
    mode: "adopt" | "offline",
  ): Promise<Task | null> {
    const task = await this.options.taskManager.hydrateRunnerRecoveryTask(
      registration.config.sessionId,
    );
    if (!task) {
      this.options.logger.warn(
        { sessionId: registration.config.sessionId },
        "runner registration has no durable session",
      );
      return null;
    }
    if (task.runner || task.executionPromise) return task;
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
          { error, sessionId: registration.config.sessionId },
          "adopted runner host consumption failed",
        );
      });
    }
    return task;
  }

  private async reapAndResume(
    registration: RunnerRegistration,
    disposition: "reap_dead" | "reap_stalled",
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
        await this.recoverRegistered(hydrated, hydrated.pidAlive ? "adopt" : "offline");
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
    if (registration.lifecycle) {
      const progressedAt = new Date((this.options.now ?? Date.now)()).toISOString();
      if (this.options.markReaped) {
        await this.options.markReaped(registration, progressedAt, error);
      } else {
        await markRegistrationReaped(registration, progressedAt, error, this.options.logger);
      }
    }
    if (registration.pidAlive) {
      await this.terminateRegistration(registration);
    }
    let task = registration.lifecycle
      ? await this.recoverRegistered({
          ...registration,
          pidAlive: false,
          lifecycle: {
            ...registration.lifecycle,
            execution_state: "reaped",
            terminal_error: error,
          },
        }, "offline")
      : await this.options.taskManager.hydrateRunnerRecoveryTask(
          registration.config.sessionId,
        );
    if (!task) return;
    prepareRecoveredTask(task, registration);
    await this.options.taskManager.markRunnerFailureAndResume(
      task,
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

  private async resumeReaped(registration: RunnerRegistration): Promise<void> {
    const hydrated = await (this.options.hydrate ?? hydrateRunnerRegistration)(registration);
    if (hydrated.pidAlive) await this.terminateRegistration(hydrated);
    const task = await this.recoverRegistered({ ...hydrated, pidAlive: false }, "offline");
    if (!task) return;
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

async function markRegistrationReaped(
  registration: RunnerRegistration,
  progressedAt: string,
  error: { code: string; message: string },
  logger: Pick<Logger, "warn">,
): Promise<void> {
  const lifecycle = RunnerSqliteLifecycle.open(
    registration.config.paths.databasePath,
    undefined,
    {
      onSummaryRenameFailure: (renameError, path) => logger.warn(
        { error: renameError, path },
        "Runner lifecycle summary rename retries exhausted; durable SQLite state retained",
      ),
    },
  );
  try {
    lifecycle.reap(
      registration.lifecycle!.execution_command_id,
      progressedAt,
      error,
    );
  } finally {
    lifecycle.close();
  }
}

function prepareRecoveredTask(task: Task, registration: RunnerRegistration): void {
  task.agentProfileSnapshot = registration.config.agent;
  const backendSessionId = registration.bootstrap?.payload.backend_session_id;
  if (backendSessionId) task.codexThreadId = backendSessionId;
}
