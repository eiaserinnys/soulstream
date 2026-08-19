import { randomBytes } from "node:crypto";

import type { TaskStatus, TerminationReason } from "./task_models.js";

export const EXECUTION_ENTRY_PATHS = ["initial", "auto_resume", "adopt"] as const;
export type ExecutionEntryPath = (typeof EXECUTION_ENTRY_PATHS)[number];

export const EXECUTION_OWNER_KINDS = [
  "runner_process",
  "adopted_runner",
  "in_process",
] as const;
export type ExecutionOwnerKind = (typeof EXECUTION_OWNER_KINDS)[number];

export const RUNNER_TERMINAL_FACTS = [
  "completed",
  "failed",
  "reaped",
  "closed",
] as const;
export type RunnerTerminalFact = (typeof RUNNER_TERMINAL_FACTS)[number];

export interface ExecutionIdentityProof {
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: string;
}

export interface ExecutionOwnershipToken extends ExecutionIdentityProof {
  ownerKind: ExecutionOwnerKind;
  manifestId: string;
  runtimeEnvIdentity: string;
  ownershipGeneration: number;
}

export const EXECUTION_OWNERSHIP_PHASES = [
  "reserved",
  "identity_proven",
  "active",
  "terminal",
  "failed",
] as const;
export type ExecutionOwnershipPhase = (typeof EXECUTION_OWNERSHIP_PHASES)[number];

export interface CanonicalExecutionOwnership {
  ownershipGeneration: number;
  ownerKind: ExecutionOwnerKind;
  manifestId: string;
  runtimeEnvIdentity: string;
  registrationId: string | null;
  pid: number | null;
  startIdentity: string | null;
  executionCommandId: string | null;
  phase: ExecutionOwnershipPhase;
  failureReason: string | null;
}

export class ExecutionOwnershipConflictError extends Error {
  readonly reason = "reservation_in_flight" as const;

  constructor(
    readonly sessionId: string,
    public retryAt: string,
    readonly phase: ExecutionOwnershipPhase,
  ) {
    super(`Execution ownership conflict: ${sessionId}`);
    this.name = "ExecutionOwnershipConflictError";
  }

  retryImmediately(now = new Date()): void {
    this.retryAt = now.toISOString();
  }
}

export function isExecutionOwnershipConflictError(
  error: unknown,
): error is ExecutionOwnershipConflictError {
  return error instanceof ExecutionOwnershipConflictError
    || (
      error instanceof Error
      && error.name === "ExecutionOwnershipConflictError"
      && (error as Partial<ExecutionOwnershipConflictError>).reason === "reservation_in_flight"
      && typeof (error as Partial<ExecutionOwnershipConflictError>).retryAt === "string"
    );
}

export interface RecoveredExecutionOwnershipIdentity {
  manifestId: string;
  runtimeEnvIdentity: string;
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: string;
}

export interface ExecutionOwnershipObservation {
  manifestId: string | null;
  runtimeEnvIdentity: string | null;
  registrationId: string | null;
  pid: number | null;
  startIdentity: string | null;
  executionCommandId: string | null;
  observedAt: Date;
}

export function newExecutionOwnershipGeneration(): number {
  const generation = randomBytes(6).readUIntBE(0, 6);
  return generation === 0 ? 1 : generation;
}

export function executionEntryTransitionId(
  path: ExecutionEntryPath,
  ownershipGeneration: number,
): string {
  if (!Number.isSafeInteger(ownershipGeneration) || ownershipGeneration <= 0) {
    throw new Error("positive execution ownership generation required");
  }
  return `${path}:${ownershipGeneration}`;
}

export function isCompleteExecutionIdentity(
  value: Partial<ExecutionIdentityProof>,
): value is ExecutionIdentityProof {
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
  switch (fact) {
    case "completed":
      return { status: "completed", terminationReason: "completed_ok" };
    case "failed":
    case "reaped":
      return { status: "error", terminationReason: "error_aborted" };
    case "closed":
      return { status: "interrupted", terminationReason: "killed" };
  }
}
