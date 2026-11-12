import { transition } from "xstate";

import {
  RUNNER_LIFECYCLE_STEP_EVENT,
  runnerLifecycleMachine,
  type RunnerLifecycleDecision,
  type RunnerLifecycleState,
  type RunnerLifecycleStep,
} from "./runner_lifecycle_machine.js";

interface SymbolicAction {
  type: string;
}

function isVerdict(action: SymbolicAction): boolean {
  return action.type === "apply"
    || action.type === "reject"
    || action.type === "ignore";
}

/**
 * 상태, 걸음, 실행 명령 번호 일치의 한 조합에 대한 판정을 기계 정의에서 낸다.
 * 액터도 SQL도 부르지 않는다. 판정이 없으면 빈 칸이므로 던진다.
 */
export function decideRunnerLifecycleStep(
  state: RunnerLifecycleState,
  step: RunnerLifecycleStep,
  commandMatches: boolean,
): RunnerLifecycleDecision {
  const snapshot = runnerLifecycleMachine.resolveState({
    value: state,
    context: {},
  });
  const [, actions] = transition(runnerLifecycleMachine, snapshot, {
    type: RUNNER_LIFECYCLE_STEP_EVENT[step],
    commandMatches,
  });
  const verdict = (actions as SymbolicAction[]).find(isVerdict);
  if (verdict === undefined) {
    throw new Error(
      `runner lifecycle decision missing: ${state}/${step}/${String(commandMatches)}`,
    );
  }
  return verdict.type as RunnerLifecycleDecision;
}
