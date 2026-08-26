import type { TaskStatus, TerminationReason } from "../../src/task/task_models.js";

export type DViolation =
  | "completed_turn_still_owned"
  | "post_complete_ipc_unfenced"
  | "successor_generation_not_fresh"
  | "terminal_writer_not_single_owner"
  | "terminal_status_overwritten"
  | "message_not_delivered_immediately";

export type DMutation =
  | "retain_active_status_owner"
  | "omit_ipc_generation_fence"
  | "reuse_execution_generation"
  | "duplicate_terminal_writer"
  | "drop_successor_delivery";

export type DRepair =
  | "release_completed_turn_owner"
  | "remove_old_runner_ipc"
  | "start_fresh_successor_generation"
  | "keep_terminal_writer_single"
  | "deliver_successor_message";

export interface DObservation {
  logicalTerminalEvents: Array<"result" | "complete">;
  turnOwnerAfterComplete: "none" | "active_status";
  postCompleteRunnerApplyCalls: number;
  ipcCallerGenerationCheck: "not_applicable" | "matched" | "absent" | "mismatched";
  successorGenerationChanged: boolean;
  terminalWriterOwners: string[];
  terminalStatus: TaskStatus;
  terminationReason: TerminationReason;
  successorModelInputs: number;
  successorResults: number;
  successorCompletes: number;
}

export interface DAssertionResult {
  assertion: DViolation;
  passes: boolean;
}

interface DAssertion {
  name: DViolation;
  isViolated: (observation: DObservation) => boolean;
}

const ASSERTIONS: readonly DAssertion[] = [
  {
    name: "completed_turn_still_owned",
    isViolated: (observation) =>
      hasLogicalTerminalPair(observation) && observation.turnOwnerAfterComplete !== "none",
  },
  {
    name: "post_complete_ipc_unfenced",
    isViolated: (observation) => observation.postCompleteRunnerApplyCalls > 0
      && observation.ipcCallerGenerationCheck !== "matched",
  },
  {
    name: "successor_generation_not_fresh",
    isViolated: (observation) => !observation.successorGenerationChanged,
  },
  {
    name: "terminal_writer_not_single_owner",
    isViolated: (observation) => new Set(observation.terminalWriterOwners).size !== 1,
  },
  {
    name: "terminal_status_overwritten",
    isViolated: (observation) => observation.terminalStatus !== "completed"
      || observation.terminationReason !== "completed_ok",
  },
  {
    name: "message_not_delivered_immediately",
    isViolated: (observation) => observation.successorModelInputs !== 1
      || observation.successorResults !== 1
      || observation.successorCompletes !== 1,
  },
];

export function dAssertionResults(observation: DObservation): DAssertionResult[] {
  return ASSERTIONS.map((assertion) => ({
    assertion: assertion.name,
    passes: !assertion.isViolated(observation),
  }));
}

export function dViolations(observation: DObservation): DViolation[] {
  return dAssertionResults(observation)
    .filter((result) => !result.passes)
    .map((result) => result.assertion);
}

export function idealDObservation(): DObservation {
  return {
    logicalTerminalEvents: ["result", "complete"],
    turnOwnerAfterComplete: "none",
    postCompleteRunnerApplyCalls: 0,
    ipcCallerGenerationCheck: "not_applicable",
    successorGenerationChanged: true,
    terminalWriterOwners: ["turn_completion"],
    terminalStatus: "completed",
    terminationReason: "completed_ok",
    successorModelInputs: 1,
    successorResults: 1,
    successorCompletes: 1,
  };
}

export function productFixedDCounterfactual(
  observation: DObservation,
): DObservation {
  return {
    ...observation,
    turnOwnerAfterComplete: "none",
    postCompleteRunnerApplyCalls: 0,
    ipcCallerGenerationCheck: "not_applicable",
    successorGenerationChanged: true,
    terminalWriterOwners: ["turn_completion"],
    terminalStatus: "completed",
    terminationReason: "completed_ok",
    successorModelInputs: 1,
    successorResults: 1,
    successorCompletes: 1,
  };
}

export function applyDRepair(
  observation: DObservation,
  repair: DRepair,
): DObservation {
  switch (repair) {
    case "release_completed_turn_owner":
      return { ...observation, turnOwnerAfterComplete: "none" };
    case "remove_old_runner_ipc":
      return {
        ...observation,
        postCompleteRunnerApplyCalls: 0,
        ipcCallerGenerationCheck: "not_applicable",
      };
    case "start_fresh_successor_generation":
      return { ...observation, successorGenerationChanged: true };
    case "keep_terminal_writer_single":
      return {
        ...observation,
        terminalWriterOwners: ["turn_completion"],
        terminalStatus: "completed",
        terminationReason: "completed_ok",
      };
    case "deliver_successor_message":
      return {
        ...observation,
        successorModelInputs: 1,
        successorResults: 1,
        successorCompletes: 1,
      };
  }
}

export function applyDMutation(
  observation: DObservation,
  mutation: DMutation,
): DObservation {
  switch (mutation) {
    case "retain_active_status_owner":
      return { ...observation, turnOwnerAfterComplete: "active_status" };
    case "omit_ipc_generation_fence":
      return {
        ...observation,
        postCompleteRunnerApplyCalls: 1,
        ipcCallerGenerationCheck: "absent",
      };
    case "reuse_execution_generation":
      return { ...observation, successorGenerationChanged: false };
    case "duplicate_terminal_writer":
      return {
        ...observation,
        terminalWriterOwners: ["turn_completion", "engine_failure_recovery"],
        terminalStatus: "error",
        terminationReason: "error_aborted",
      };
    case "drop_successor_delivery":
      return {
        ...observation,
        successorModelInputs: 0,
        successorResults: 0,
        successorCompletes: 0,
      };
  }
}

function hasLogicalTerminalPair(observation: DObservation): boolean {
  return observation.logicalTerminalEvents.includes("result")
    && observation.logicalTerminalEvents.includes("complete");
}
