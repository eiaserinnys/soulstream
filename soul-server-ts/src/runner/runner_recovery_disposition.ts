import type { Logger } from "pino";

import type { Task } from "../task/task_models.js";
import type {
  RunnerRegistration,
  RunnerRecoveryDisposition,
} from "./runner_process_registry.js";
import {
  classifyRunnerRegistration,
  hydrateRunnerRegistration,
} from "./runner_process_registry.js";
import type { RunnerRecoveryLogger } from "./runner_recovery_logging.js";
import { closedRunnerTailRequiresDrain } from "./runner_recovery_scan_observer.js";
import {
  hasRecordedTerminal,
  prepareRecoveredTask,
} from "./runner_recovery_task.js";

export type RecoverableRunnerDisposition = Extract<
  RunnerRecoveryDisposition,
  "adopt_prebootstrap" | "adopt_running" | "replay_terminal" | "replay_terminal_dead"
>;

export function dispositionRequiresTask(
  disposition: RunnerRecoveryDisposition,
): boolean {
  return disposition !== "wait_for_bootstrap" && disposition !== "retired_terminal";
}

/** A stale lifecycle row must not touch the execution that replaced it. */
export function heldExecutionSupersedesRegistration(
  task: Task,
  registration: RunnerRegistration,
): boolean {
  const holdsExecution = task.executionPromise !== undefined
    || task.executionActivation !== undefined
    || task.runner?.dispatcher.hasActiveExecution() === true;
  if (!holdsExecution) return false;
  return registration.pidAlive
    || task.runner?.dispatcher.registrationId() !== registration.registrationId;
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
}): Promise<void> {
  try {
    await input.handle(input.registration, input.disposition, input.task);
    input.recoveryLogger.clear(input.registration.config.sessionId);
  } catch (error) {
    input.recoveryLogger.failure(input.registration, input.disposition, error);
  }
}

/**
 * 오프라인 재생이 끝난 종료 등록을 안전할 때만 은퇴시킨다.
 *
 * 은퇴는 되돌릴 수 없다. `retired_terminal`은 이후 훑기에서 통째로 빠지므로 등록은
 * 그 러너의 종료를 아직 들고 있는 마지막 자리다. 그래서 다른 은퇴 호출처와 같은
 * 조건을 쓴다: 재생이 실제로 돌았고(안 돌았으면 "registration kept for a later
 * scan"), 그 세션의 종료가 기록되었으며, 닫힌 꼬리가 남았으면 은퇴 전에 비운다.
 * 조건이 안 맞으면 지금처럼 등록을 남겨 다음 훑기에 맡긴다.
 */
export async function retireTerminalRegistrationAfterReplay(input: {
  registration: RunnerRegistration;
  task: Task;
  replayed: boolean;
  disposition: string;
  retireTerminal(registration: RunnerRegistration): Promise<void>;
  drainClosedTail(registration: RunnerRegistration): Promise<void>;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<boolean> {
  const sessionId = input.registration.config.sessionId;
  if (!input.replayed) {
    input.logger.warn(
      { sessionId, disposition: input.disposition },
      "terminal runner replay was skipped; registration kept for a later scan",
    );
    return false;
  }
  if (!hasRecordedTerminal(input.task)) {
    input.logger.warn(
      { sessionId, disposition: input.disposition },
      "terminal runner session end is not recorded; registration kept for a later scan",
    );
    return false;
  }
  // `closedTailState`가 없는 등록은 닫힌 꼬리를 읽지 않은(비종료 lifecycle) 등록이다.
  // 꼬리가 남은 채로 은퇴시키면 그 꼬리를 다시 열 길은 주기 훑기의 retired-tail drain뿐이다.
  if (
    input.registration.closedTailState !== undefined
    && closedRunnerTailRequiresDrain(input.registration)
  ) {
    await input.drainClosedTail(input.registration);
  }
  await input.retireTerminal(input.registration);
  input.logger.info(
    { sessionId, disposition: input.disposition },
    "terminal runner registration retired after replay",
  );
  return true;
}

export async function terminalizeReapedRunner(input: {
  registration: RunnerRegistration;
  task: Task;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  terminate(registration: RunnerRegistration): Promise<void>;
  invalidate(registration: RunnerRegistration): Promise<void>;
  retireAttached(registration: RunnerRegistration): Promise<boolean>;
  recoverOffline(
    registration: RunnerRegistration,
    task: Task,
  ): Promise<{ task: Task; replayed: boolean }>;
  retireTerminal(registration: RunnerRegistration): Promise<void>;
  drainClosedTail(registration: RunnerRegistration): Promise<void>;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<void> {
  const hydrated = await (input.hydrate ?? hydrateRunnerRegistration)(input.registration);
  if (heldExecutionSupersedesRegistration(input.task, hydrated)) {
    input.logger.info(
      { sessionId: hydrated.config.sessionId, disposition: "already_reaped" },
      "reaped runner recovery skipped because a newer execution owns the session",
    );
    return;
  }
  if (await input.retireAttached(hydrated)) return;
  if (hydrated.pidAlive) await input.terminate(hydrated);
  await input.invalidate(hydrated);
  prepareRecoveredTask(input.task, hydrated);
  input.task.runnerTerminalFact = "reaped";
  const recovered = await input.recoverOffline({ ...hydrated, pidAlive: false }, input.task);
  input.logger.info(
    { sessionId: hydrated.config.sessionId, disposition: "already_reaped" },
    "reaped runner recovery terminalized",
  );
  await retireTerminalRegistrationAfterReplay({
    registration: hydrated,
    task: recovered.task,
    replayed: recovered.replayed,
    disposition: "already_reaped",
    retireTerminal: input.retireTerminal,
    drainClosedTail: input.drainClosedTail,
    logger: input.logger,
  });
}

export async function terminalizeFailedRunner(input: {
  registration: RunnerRegistration;
  disposition: "reap_dead";
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
    disposition: "reap_dead",
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
  await input.terminalize(
    hydrated,
    input.task,
    {
      code: "runner_exited",
      message: "runner process exited before execution completed",
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
