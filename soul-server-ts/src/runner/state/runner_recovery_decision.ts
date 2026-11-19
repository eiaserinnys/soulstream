import type { RunnerLifecycleState } from "./runner_lifecycle_machine.js";

export type RunnerRecoveryDisposition =
  | "wait_for_bootstrap"
  | "adopt_prebootstrap"
  | "adopt_running"
  | "replay_terminal"
  | "replay_terminal_dead"
  | "retired_terminal"
  | "reap_dead"
  | "already_reaped"
  | "closed";

export interface RunnerRecoveryFacts {
  retired: boolean;
  lifecycle: RunnerLifecycleState;
  pidAlive: boolean;
  bootstrapLeaseElapsed: boolean;
}

export const RUNNER_RECOVERY_DISPOSITIONS: readonly RunnerRecoveryDisposition[] = [
  "wait_for_bootstrap",
  "adopt_prebootstrap",
  "adopt_running",
  "replay_terminal",
  "replay_terminal_dead",
  "retired_terminal",
  "reap_dead",
  "already_reaped",
  "closed",
];

const isTerminal = (state: RunnerLifecycleState): boolean =>
  state === "completed" || state === "failed";

export function decideRunnerRecovery(
  facts: RunnerRecoveryFacts,
): RunnerRecoveryDisposition {
  if (facts.retired) return "retired_terminal";
  if (!facts.retired && facts.lifecycle === "reaped") return "already_reaped";
  if (!facts.retired && facts.lifecycle === "closed") return "closed";
  if (!facts.retired && facts.lifecycle === "none" && facts.pidAlive) return "adopt_prebootstrap";
  if (!facts.retired && facts.lifecycle === "none" && !facts.pidAlive
    && facts.bootstrapLeaseElapsed) return "reap_dead";
  if (!facts.retired && facts.lifecycle === "none" && !facts.pidAlive
    && !facts.bootstrapLeaseElapsed) return "wait_for_bootstrap";
  if (!facts.retired && isTerminal(facts.lifecycle) && facts.pidAlive) return "replay_terminal";
  if (!facts.retired && isTerminal(facts.lifecycle) && !facts.pidAlive) return "replay_terminal_dead";
  if (!facts.retired && facts.lifecycle === "running" && !facts.pidAlive) return "reap_dead";
  if (!facts.retired && facts.lifecycle === "running" && facts.pidAlive) return "adopt_running";
  throw new Error(`runner recovery decision missing: ${JSON.stringify(facts)}`);
}
