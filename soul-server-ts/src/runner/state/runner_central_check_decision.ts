import {
  TERMINAL_ADOPT_REJECTION_REASONS,
  classifyRunnerAdoptRejection,
} from "../../task/state/node_adopt_rejection.js";

export type RunnerCentralLookup =
  | "missing"
  | "lookup_error"
  | "owner_node_changed"
  | "active"
  | "inactive";

export type RunnerAdoptResponse =
  | "none"
  | "retryable_rejection"
  | "terminal_rejection";

export type RunnerCentralCheckDecision =
  | "reap"
  | "adopt"
  | "keep"
  | "keep_retry";

export interface RunnerCentralCheckFacts {
  lookup: RunnerCentralLookup;
  terminalRetained: boolean;
  registrationAppliedAndTurnRunning: boolean;
  adoptResponse: RunnerAdoptResponse;
}

export const RUNNER_CENTRAL_LOOKUPS: readonly RunnerCentralLookup[] = [
  "missing",
  "lookup_error",
  "owner_node_changed",
  "active",
  "inactive",
];

export const RUNNER_ADOPT_RESPONSES: readonly RunnerAdoptResponse[] = [
  "none",
  "retryable_rejection",
  "terminal_rejection",
];

export const RUNNER_CENTRAL_CHECK_DECISIONS: readonly RunnerCentralCheckDecision[] = [
  "reap",
  "adopt",
  "keep",
  "keep_retry",
];

export { TERMINAL_ADOPT_REJECTION_REASONS, classifyRunnerAdoptRejection };

export const RUNNER_CENTRAL_RETRY_BASE_MS = 15_000;
export const RUNNER_CENTRAL_RETRY_MAX_MS = 300_000;

export function runnerCentralRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(
    RUNNER_CENTRAL_RETRY_BASE_MS * 2 ** exponent,
    RUNNER_CENTRAL_RETRY_MAX_MS,
  );
}

export function decideRunnerCentralCheck(
  facts: RunnerCentralCheckFacts,
): RunnerCentralCheckDecision {
  if (facts.lookup === "missing") return "reap";
  if (facts.lookup === "owner_node_changed") return "reap";
  if (facts.adoptResponse === "terminal_rejection" && facts.terminalRetained) {
    return "keep";
  }
  if (facts.adoptResponse === "terminal_rejection") return "reap";
  if (facts.lookup === "lookup_error") return "keep";
  if (facts.lookup === "active") return "keep";
  if (facts.adoptResponse === "retryable_rejection") return "keep_retry";
  if (facts.lookup === "inactive" && facts.terminalRetained) return "keep";
  if (
    facts.lookup === "inactive"
    && !facts.terminalRetained
    && facts.registrationAppliedAndTurnRunning
  ) return "adopt";
  return "keep";
}
