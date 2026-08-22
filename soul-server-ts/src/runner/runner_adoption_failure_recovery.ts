import type { Logger } from "pino";

import type { Task } from "../task/task_models.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
  readRunnerRegistrationSummary,
  type RunnerRegistration,
} from "./runner_process_registry.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import { prepareRecoveredTask } from "./runner_recovery_task.js";

export type RunnerAdoptionDisposition = "adopt_prebootstrap" | "adopt_running";

export interface RunnerAdoptionFailureRecoveryDeps {
  leaseTimeoutMs: number;
  logger: Pick<Logger, "info" | "warn">;
  now?(): number;
  refreshRegistration?(registration: RunnerRegistration): Promise<RunnerRegistration>;
  hydrateRegistration?(registration: RunnerRegistration): Promise<RunnerRegistration>;
  terminateRegistration(registration: RunnerRegistration): Promise<void>;
  invalidateRegistration(registration: RunnerRegistration): Promise<void>;
  markReaped(
    registration: RunnerRegistration,
    progressedAt: string,
    error: { code: string; message: string },
  ): Promise<void>;
  recoverOffline(registration: RunnerRegistration, task: Task): Promise<Task>;
  resumeReplacement(task: Task, message: string, config: RunnerChildConfig): Promise<void>;
  onFailure(
    registration: RunnerRegistration,
    disposition: RunnerAdoptionDisposition,
    error: unknown,
  ): void;
}

/** Converts a failed live adoption into one identity-fenced replacement path. */
export class RunnerAdoptionFailureRecovery {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly deps: RunnerAdoptionFailureRecoveryDeps) {}

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  pending(): Promise<void>[] {
    return [...this.active.values()];
  }

  schedule(input: {
    registration: RunnerRegistration;
    disposition: RunnerAdoptionDisposition;
    task: Task;
    completion: Promise<void>;
    ownedRunner: Task["runner"];
    error: unknown;
  }): void {
    const sessionId = input.registration.config.sessionId;
    if (this.active.has(sessionId)) return;
    const recovery = this.recover(input).catch((error) => {
      this.deps.onFailure(input.registration, input.disposition, error);
    }).finally(() => {
      if (this.active.get(sessionId) === recovery) this.active.delete(sessionId);
    });
    this.active.set(sessionId, recovery);
  }

  async terminalize(
    registration: RunnerRegistration,
    task: Task,
    error: { code: string; message: string },
    disposition: "reap_dead" | "reap_stalled" | "socket_unavailable",
  ): Promise<void> {
    if (registration.pidAlive) {
      await this.deps.terminateRegistration(registration);
      registration = { ...registration, pidAlive: false };
    }
    if (registration.lifecycle) {
      await this.deps.markReaped(
        registration,
        new Date((this.deps.now ?? Date.now)()).toISOString(),
        error,
      );
    }
    await this.deps.invalidateRegistration(registration);
    const recoveredTask = registration.lifecycle
      ? await this.deps.recoverOffline({
          ...registration,
          pidAlive: false,
          lifecycle: {
            ...registration.lifecycle,
            execution_state: "reaped",
            terminal_error: error,
          },
        }, task)
      : task;
    prepareRecoveredTask(recoveredTask, registration);
    recoveredTask.runnerTerminalFact = "reaped";
    await this.deps.resumeReplacement(recoveredTask, error.message, registration.config);
    this.deps.logger.info(
      { sessionId: registration.config.sessionId, disposition },
      "runner failure drained and auto-resumed",
    );
  }

  private async recover(input: {
    registration: RunnerRegistration;
    disposition: RunnerAdoptionDisposition;
    task: Task;
    completion: Promise<void>;
    ownedRunner: Task["runner"];
    error: unknown;
  }): Promise<void> {
    const { registration, disposition, task, completion, ownedRunner, error } = input;
    // Task execution identity is the first fence. A newer turn owns both its
    // runner and registration; this recovery must not touch either.
    //
    // Absence is not supersession. An adoption that rejects before it assigns
    // `task.executionPromise` leaves the slot empty, and reading empty as "a
    // newer execution owns this" abandons a live runner that still holds the
    // session's execution ownership.
    const supersededBy = supersedingExecution(task, completion, ownedRunner);
    if (supersededBy) {
      this.deps.logger.warn(
        { ...recoveryLogContext(registration, error, disposition), supersededBy },
        "runner adoption failure was superseded by a newer execution",
      );
      return;
    }
    task.executionPromise = undefined;
    if (task.runner === ownedRunner) {
      task.runner = undefined;
      task.runnerRetainedForClaudeBackground = undefined;
      await ownedRunner?.dispatcher.detachHost().catch((detachError) => {
        this.deps.logger.warn(
          { err: detachError, sessionId: registration.config.sessionId },
          "failed runner host detach could not release local resources",
        );
      });
    }

    // Refresh PID and start identity after the socket failure. The old scan is
    // never authority for a process that could have died during the deadline.
    const refreshed = await (this.deps.refreshRegistration
      ?? refreshRunnerRegistration)(registration);
    const hydrated = await (this.deps.hydrateRegistration
      ?? hydrateRunnerRegistration)(refreshed);
    const verifiedDisposition = classifyRunnerRegistration(
      hydrated,
      (this.deps.now ?? Date.now)(),
      this.deps.leaseTimeoutMs,
    );
    if (verifiedDisposition === "reap_dead" || verifiedDisposition === "reap_stalled") {
      this.deps.logger.info(
        recoveryLogContext(registration, error, verifiedDisposition),
        "runner adoption failed and refreshed registration is no longer live",
      );
      await this.terminalize(
        hydrated,
        task,
        verifiedDisposition === "reap_stalled"
          ? { code: "lease_expired", message: "runner progress lease expired" }
          : { code: "runner_exited", message: "runner process exited before execution completed" },
        verifiedDisposition,
      );
      return;
    }
    if (
      disposition === "adopt_running"
      && verifiedDisposition === "adopt_running"
      && errorChainHasCode(error, "ENOENT")
    ) {
      this.deps.logger.info(
        { ...recoveryLogContext(registration, error, verifiedDisposition), pid: hydrated.pid },
        "identity-verified runner with a missing socket will be replaced",
      );
      await this.terminalize(
        hydrated,
        task,
        {
          code: "socket_unavailable",
          message: "runner socket disappeared while the registered process remained alive",
        },
        "socket_unavailable",
      );
      return;
    }
    this.deps.logger.warn(
      recoveryLogContext(registration, error, verifiedDisposition),
      "live runner adoption failed but registration is not safe to replace",
    );
  }
}

/**
 * Names the newer execution that owns this session, or undefined when none
 * does. Only a *present* execution or runner that is not the one this recovery
 * started can supersede it.
 */
function supersedingExecution(
  task: Task,
  completion: Promise<void>,
  ownedRunner: Task["runner"],
): "runner" | "execution" | undefined {
  if (task.runner !== undefined && task.runner !== ownedRunner) return "runner";
  if (task.executionPromise === completion) return undefined;
  // An empty slot is not supersession. Lab scenario F9 showed every adoption
  // rejection landing here as `execution_absent`: the release identity gate
  // throws before `recoverRunnerExecution` assigns `task.executionPromise`,
  // so nothing newer exists and standing down abandons the replacement path.
  if (task.executionPromise === undefined) return undefined;
  return "execution";
}

async function refreshRunnerRegistration(
  registration: RunnerRegistration,
): Promise<RunnerRegistration> {
  return await readRunnerRegistrationSummary(
    registration.config.paths.sessionDirectory,
    { verifyProcessIdentity: true },
  );
}

function recoveryLogContext(
  registration: RunnerRegistration,
  error: unknown,
  disposition: string,
) {
  return {
    err: error,
    sessionId: registration.config.sessionId,
    disposition,
    runnerDirectory: registration.config.paths.sessionDirectory,
    socketPath: registration.config.paths.socketPath,
  };
}

function errorChainHasCode(error: unknown, expectedCode: string): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === expectedCode) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
