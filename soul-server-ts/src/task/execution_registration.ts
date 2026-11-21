import { randomUUID } from "node:crypto";

import {
  terminalTaskStatusForReason,
  type Task,
  type TaskStatus,
  type TerminationReason,
} from "./task_models.js";

export const RUNNER_TERMINAL_FACTS = [
  "completed",
  "failed",
  "reaped",
  "closed",
] as const;
export type RunnerTerminalFact = (typeof RUNNER_TERMINAL_FACTS)[number];

/** The durable identity that fences events from replaced runner registrations. */
export interface ExecutionRegistration {
  registrationId: string;
  executionCommandId: string;
}

/** Process-local identity used to address one concrete runner child. */
export interface RunnerExecutionIdentity extends ExecutionRegistration {
  pid: number;
  startIdentity: string;
}

export function newExecutionCommandId(): string {
  return `command:${randomUUID()}`;
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REGISTERED_COMMAND_PATTERN = new RegExp(`^command:(${UUID_PATTERN})$`, "i");
const LIFECYCLE_COMMAND_PATTERN = new RegExp(`^execute:(${UUID_PATTERN}):${UUID_PATTERN}$`, "i");

export function newRunnerExecuteCommandId(registeredCommandId?: string): string {
  const registeredUuid = registeredCommandId?.match(REGISTERED_COMMAND_PATTERN)?.[1];
  return registeredUuid
    ? `execute:${registeredUuid}:${randomUUID()}`
    : `execute:${randomUUID()}`;
}

export function registrationCommandIdFromLifecycle(lifecycleCommandId: string): string | undefined {
  const registeredUuid = lifecycleCommandId.match(LIFECYCLE_COMMAND_PATTERN)?.[1];
  return registeredUuid === undefined ? undefined : `command:${registeredUuid}`;
}

export function lifecycleCommandMatchesRegistration(
  lifecycleCommandId: string | undefined,
  registeredCommandId: string,
): boolean {
  return lifecycleCommandId !== undefined
    && registrationCommandIdFromLifecycle(lifecycleCommandId) === registeredCommandId;
}

export function executionIsSuccessorTurn(
  task: Task,
  terminalExecutionCommandId: string | undefined,
): boolean {
  if (task.executionActivation !== undefined) return true;
  const registeredCommandId = task.executionRegistration?.executionCommandId;
  if (registeredCommandId === undefined) return false;
  return !lifecycleCommandMatchesRegistration(terminalExecutionCommandId, registeredCommandId);
}

export function isCompleteRunnerExecutionIdentity(
  value: Partial<RunnerExecutionIdentity>,
): value is RunnerExecutionIdentity {
  return typeof value.registrationId === "string"
    && value.registrationId.length > 0
    && typeof value.pid === "number"
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.startIdentity === "string"
    && value.startIdentity.length > 0
    && typeof value.executionCommandId === "string"
    && value.executionCommandId.length > 0;
}

export function runnerFactProjection(fact: RunnerTerminalFact): {
  status: TaskStatus;
  terminationReason: TerminationReason;
} {
  const terminationReason = fact === "completed"
    ? "completed_ok"
    : fact === "closed"
    ? "killed"
    : "error_aborted";
  return {
    status: terminalTaskStatusForReason(terminationReason),
    terminationReason,
  };
}
