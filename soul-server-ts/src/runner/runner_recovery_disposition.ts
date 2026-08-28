import type { Logger } from "pino";

import { isExecutionOwnershipConflictError } from "../task/execution_ownership.js";
import type { ExecutionOwnershipBackoff } from "../task/execution_ownership_backoff.js";
import type { Task } from "../task/task_models.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import type {
  RunnerRegistration,
  RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
} from "./runner_process_registry.js";
import type { RunnerRecoveryLogger } from "./runner_recovery_logging.js";
import { prepareRecoveredTask } from "./runner_recovery_task.js";

export type RecoverableRunnerDisposition = Extract<
  RunnerRecoveryDisposition,
  "adopt_prebootstrap" | "adopt_running" | "replay_terminal" | "replay_terminal_dead"
>;

export function dispositionRequiresTask(
  disposition: RunnerRecoveryDisposition,
): boolean {
  return disposition !== "wait_for_bootstrap" && disposition !== "retired_terminal";
}

/** Only these dispositions go on to reserve execution ownership. */
export function contendsForExecutionOwnership(
  disposition: RunnerRecoveryDisposition,
): boolean {
  return disposition === "adopt_prebootstrap"
    || disposition === "adopt_running"
    || disposition === "already_reaped";
}

export async function handleRecoveryWithFailureTracking(input: {
  registration: RunnerRegistration;
  disposition: RunnerRecoveryDisposition;
  task?: Task;
  handle(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    task?: Task,
  ): Promise<void>;
  recoveryLogger: RunnerRecoveryLogger;
  ownershipBackoff: ExecutionOwnershipBackoff;
}): Promise<void> {
  try {
    await input.handle(input.registration, input.disposition, input.task);
    input.recoveryLogger.clear(input.registration.config.sessionId);
    if (contendsForExecutionOwnership(input.disposition)) {
      input.ownershipBackoff.clear(input.registration.config.sessionId);
    }
  } catch (error) {
    if (isExecutionOwnershipConflictError(error)) {
      input.ownershipBackoff.observeConflict(
        input.registration.config.sessionId,
        error.retryAt,
      );
      return;
    }
    input.recoveryLogger.failure(input.registration, input.disposition, error);
  }
}

export async function resumeReapedRunner(input: {
  registration: RunnerRegistration;
  task: Task;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  terminate(registration: RunnerRegistration): Promise<void>;
  invalidate(registration: RunnerRegistration): Promise<void>;
  recoverOffline(registration: RunnerRegistration, task: Task): Promise<Task>;
  resumeReplacement(task: Task, message: string, config: RunnerChildConfig): Promise<void>;
  logger: Pick<Logger, "info">;
}): Promise<void> {
  const hydrated = await (input.hydrate ?? hydrateRunnerRegistration)(input.registration);
  if (hydrated.pidAlive) await input.terminate(hydrated);
  await input.invalidate(hydrated);
  await input.recoverOffline({ ...hydrated, pidAlive: false }, input.task);
  prepareRecoveredTask(input.task, hydrated);
  input.task.runnerTerminalFact = "reaped";
  const message = hydrated.lifecycle?.terminal_error?.message
    ?? "runner was reaped before recovery completed";
  await input.resumeReplacement(input.task, message, hydrated.config);
  input.logger.info(
    { sessionId: hydrated.config.sessionId, disposition: "already_reaped" },
    "reaped runner recovery resumed",
  );
}

export async function reapAndResumeRunner(input: {
  registration: RunnerRegistration;
  disposition: "reap_dead" | "reap_stalled";
  task: Task;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  now(): number;
  leaseTimeoutMs: number;
  recover(
    registration: RunnerRegistration,
    disposition: RecoverableRunnerDisposition,
    task: Task,
  ): Promise<Task>;
  terminalize(
    registration: RunnerRegistration,
    task: Task,
    error: { code: string; message: string },
    disposition: "reap_dead" | "reap_stalled",
  ): Promise<void>;
}): Promise<void> {
  const hydrated = await (input.hydrate ?? hydrateRunnerRegistration)(input.registration);
  const verifiedDisposition = classifyRunnerRegistration(
    hydrated,
    input.now(),
    input.leaseTimeoutMs,
  );
  if (verifiedDisposition !== input.disposition) {
    if (
      verifiedDisposition === "adopt_prebootstrap"
      || verifiedDisposition === "adopt_running"
      || verifiedDisposition === "replay_terminal"
      || verifiedDisposition === "replay_terminal_dead"
    ) await input.recover(hydrated, verifiedDisposition, input.task);
    return;
  }
  const message = input.disposition === "reap_stalled"
    ? "runner progress lease expired"
    : "runner process exited before execution completed";
  await input.terminalize(
    hydrated,
    input.task,
    {
      code: input.disposition === "reap_stalled" ? "lease_expired" : "runner_exited",
      message,
    },
    input.disposition,
  );
}

export async function recoverRunnerByDisposition(input: {
  registration: RunnerRegistration;
  disposition: RecoverableRunnerDisposition;
  task: Task;
  recoverAdopt(
    registration: RunnerRegistration,
    task: Task,
    disposition: "adopt_prebootstrap" | "adopt_running",
  ): Promise<Task>;
  recoverOffline(
    registration: RunnerRegistration,
    task: Task,
    prepare: (registration: RunnerRegistration) => Promise<RunnerRegistration>,
  ): Promise<{ task: Task; replayed: boolean }>;
  terminate(
    registration: RunnerRegistration,
  ): Promise<"registration_invalidated" | "registration_absent" | void>;
  retireTerminal(registration: RunnerRegistration): Promise<void>;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<Task> {
  if (
    input.disposition === "adopt_prebootstrap"
    || input.disposition === "adopt_running"
  ) {
    return await input.recoverAdopt(
      input.registration,
      input.task,
      input.disposition,
    );
  }
  const termination: {
    outcome: "registration_invalidated" | "registration_absent" | void;
  } = { outcome: undefined };
  const recovered = await input.recoverOffline(
    input.registration,
    input.task,
    async (guardedRegistration) => {
      if (!guardedRegistration.pidAlive) return guardedRegistration;
      termination.outcome = await input.terminate(guardedRegistration);
      return { ...guardedRegistration, pidAlive: false };
    },
  );
  if (
    input.disposition === "replay_terminal_dead"
    || termination.outcome === "registration_invalidated"
  ) {
    // Retiring is irreversible: `retired_terminal` is dropped by every later
    // scan, so the registration is the last thing that could still carry this
    // runner's terminal facts. Retiring one whose replay never ran seals the
    // session away, and the 260822 outage did exactly that under a log line
    // announcing the replay had happened.
    if (!recovered.replayed) {
      input.logger.warn(
        {
          sessionId: input.registration.config.sessionId,
          disposition: input.disposition,
        },
        "terminal runner replay was skipped; registration kept for a later scan",
      );
      return recovered.task;
    }
    await input.retireTerminal(input.registration);
    input.logger.info(
      {
        sessionId: input.registration.config.sessionId,
        disposition: input.disposition,
      },
      input.disposition === "replay_terminal_dead"
        ? "terminal runner with no live process replayed offline and retired"
        : "terminal runner stopped, replayed offline, and retired",
    );
  }
  return recovered.task;
}
