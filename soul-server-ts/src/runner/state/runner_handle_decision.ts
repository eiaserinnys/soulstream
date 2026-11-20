import type { RunnerRecoveryDisposition } from "./runner_recovery_decision.js";

export type RunnerHandleDetachedBackground = "not_probed" | "retained" | "absent";

export type RunnerHandleRetention = "not_probed" | "released" | "not_released";

export type RunnerHandleAttachedTerminal = "not_probed" | "retired" | "open";

export type RunnerHandleAction =
  | "recover_closed_engine_terminal"
  | "probe_detached_background"
  | "stop_detached_background"
  | "terminalize_dead_background"
  | "probe_expired_retention"
  | "stop_released_retention"
  | "probe_attached_terminal"
  | "stop_retired_attached_terminal"
  | "retire_recorded_terminal"
  | "recover_by_disposition"
  | "terminalize_failed"
  | "recover_closed"
  | "terminalize_reaped"
  | "unsupported";

export interface RunnerHandleFacts {
  disposition: RunnerRecoveryDisposition;
  hasTask: boolean;
  recordedTerminal: boolean;
  closedEngineTerminal: boolean;
  detachedBackground: RunnerHandleDetachedBackground;
  retention: RunnerHandleRetention;
  attachedTerminal: RunnerHandleAttachedTerminal;
  deadBackgroundTerminalized: boolean;
  hasRunner: boolean;
  hasExecutionPromise: boolean;
}

export const RUNNER_HANDLE_BACKGROUND_STATES: readonly RunnerHandleDetachedBackground[] = [
  "not_probed",
  "retained",
  "absent",
];

export const RUNNER_HANDLE_RETENTION_STATES: readonly RunnerHandleRetention[] = [
  "not_probed",
  "released",
  "not_released",
];

export const RUNNER_HANDLE_ATTACHED_TERMINAL_STATES: readonly RunnerHandleAttachedTerminal[] = [
  "not_probed",
  "retired",
  "open",
];

export const RUNNER_HANDLE_ACTIONS: readonly RunnerHandleAction[] = [
  "recover_closed_engine_terminal",
  "probe_detached_background",
  "stop_detached_background",
  "terminalize_dead_background",
  "probe_expired_retention",
  "stop_released_retention",
  "probe_attached_terminal",
  "stop_retired_attached_terminal",
  "retire_recorded_terminal",
  "recover_by_disposition",
  "terminalize_failed",
  "recover_closed",
  "terminalize_reaped",
  "unsupported",
];

const isAdoptionOrReplay = (disposition: RunnerRecoveryDisposition): boolean =>
  disposition === "adopt_prebootstrap"
  || disposition === "adopt_running"
  || disposition === "replay_terminal"
  || disposition === "replay_terminal_dead";

export function decideRunnerHandle(facts: RunnerHandleFacts): RunnerHandleAction {
  if (
    facts.hasTask
    && facts.disposition === "replay_terminal"
    && facts.closedEngineTerminal
  ) return "recover_closed_engine_terminal";
  if (
    facts.hasTask
    && facts.disposition === "replay_terminal"
    && facts.detachedBackground === "not_probed"
  ) return "probe_detached_background";
  if (
    facts.hasTask
    && facts.disposition === "replay_terminal"
    && facts.detachedBackground === "retained"
  ) return "stop_detached_background";
  if (facts.disposition === "replay_terminal_dead" && !facts.deadBackgroundTerminalized) {
    return "terminalize_dead_background";
  }
  if (
    facts.hasTask && facts.recordedTerminal
    && facts.retention === "not_probed"
  ) return "probe_expired_retention";
  if (
    facts.hasTask && facts.recordedTerminal
    && facts.retention === "released"
  ) return "stop_released_retention";
  if (
    facts.hasTask && facts.recordedTerminal
    && facts.attachedTerminal === "not_probed"
  ) return "probe_attached_terminal";
  if (
    facts.hasTask && facts.recordedTerminal
    && facts.attachedTerminal === "retired"
  ) return "stop_retired_attached_terminal";
  if (
    facts.hasTask && facts.recordedTerminal
    && !facts.hasRunner && !facts.hasExecutionPromise
  ) return "retire_recorded_terminal";
  if (isAdoptionOrReplay(facts.disposition)) return "recover_by_disposition";
  if (facts.disposition === "reap_dead") return "terminalize_failed";
  if (facts.disposition === "closed") return "recover_closed";
  if (facts.disposition === "already_reaped") return "terminalize_reaped";
  return "unsupported";
}
