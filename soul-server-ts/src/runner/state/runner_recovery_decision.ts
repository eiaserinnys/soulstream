import { transition } from "xstate";

import {
  runnerRecoveryMachine,
  type RunnerRecoveryDisposition,
  type RunnerRecoveryFacts,
} from "./runner_recovery_machine.js";

interface VerdictAction {
  type: "verdict";
  params: { disposition: RunnerRecoveryDisposition };
}

/**
 * 복구 가름을 기계 정의에서 낸다. 판정이 없으면 빈 칸이므로 던진다.
 */
export function decideRunnerRecovery(
  facts: RunnerRecoveryFacts,
): RunnerRecoveryDisposition {
  const snapshot = runnerRecoveryMachine.resolveState({
    value: "decide",
    context: {},
  });
  const [, actions] = transition(runnerRecoveryMachine, snapshot, {
    type: "CLASSIFY",
    ...facts,
  });
  const verdict = (actions as { type: string; params?: unknown }[]).find(
    (action) => action.type === "verdict",
  ) as VerdictAction | undefined;
  if (verdict === undefined) {
    throw new Error(`runner recovery decision missing: ${JSON.stringify(facts)}`);
  }
  return verdict.params.disposition;
}
