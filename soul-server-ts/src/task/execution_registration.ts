import { randomUUID } from "node:crypto";

import {
  terminalTaskStatusForReason,
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
