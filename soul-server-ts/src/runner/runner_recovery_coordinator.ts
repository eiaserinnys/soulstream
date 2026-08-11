import type { Logger } from "pino";

import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { Task } from "../task/task_models.js";
import {
  classifyRunnerRegistration,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import { RunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";

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
  logger: Pick<Logger, "error" | "info" | "warn">;
  spawner?: Pick<RunnerProcessSpawner, "terminate">;
  scan?: typeof scanRunnerRegistrations;
  now?: () => number;
  markReaped?: (
    registration: RunnerRegistration,
    progressedAt: string,
    error: { code: string; message: string },
  ) => Promise<void>;
  releaseGarbageCollector?: Pick<RunnerReleaseGarbageCollector, "collect">;
}

/** Owns runner adoption and failure recovery; no domain state is derived here. */
export class RunnerRecoveryCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly scans = new Set<Promise<void>>();
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
    const scan = this.performScan();
    this.scans.add(scan);
    try {
      await scan;
    } finally {
      this.scans.delete(scan);
    }
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
        || disposition === "already_reaped"
        || disposition === "closed"
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
    if (this.options.releaseGarbageCollector) {
      try {
        await this.options.releaseGarbageCollector.collect();
      } catch (error) {
        this.options.logger.error({ error }, "runner release GC failed");
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
    while (this.scans.size > 0 || this.active.size > 0) {
      await Promise.allSettled([
        ...this.scans,
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
    const lifecycle = registration.lifecycle;
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
    prepareRecoveredTask(task, registration);
    const completion = this.options.taskExecutor.recoverRegisteredRunner(
      task,
      registration.config,
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
        await markRegistrationReaped(registration, progressedAt, error);
      }
    }
    if (registration.pidAlive) {
      await (this.options.spawner ?? new RunnerProcessSpawner()).terminate(
        registration.config.paths,
      );
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
}

async function markRegistrationReaped(
  registration: RunnerRegistration,
  progressedAt: string,
  error: { code: string; message: string },
): Promise<void> {
  const lifecycle = RunnerSqliteLifecycle.open(registration.config.paths.databasePath);
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
