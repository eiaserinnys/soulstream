import { transition } from "xstate";

import {
  TERMINAL_ADOPT_REJECTION_REASONS,
  classifyRunnerAdoptRejection,
} from "../../task/state/node_adopt_rejection.js";
import {
  runnerCentralCheckMachine,
  type RunnerAdoptResponse,
  type RunnerCentralCheckDecision,
  type RunnerCentralCheckFacts,
} from "./runner_central_check_machine.js";

interface VerdictAction {
  type: "verdict";
  params: { decision: RunnerCentralCheckDecision };
}

/** 사유 분류의 정본은 task/state다. 기존 호출자를 위해 다시 내보낸다. */
export { TERMINAL_ADOPT_REJECTION_REASONS, classifyRunnerAdoptRejection };

export const RUNNER_CENTRAL_RETRY_BASE_MS = 15_000;
export const RUNNER_CENTRAL_RETRY_MAX_MS = 300_000;

/**
 * 다시 될 수 있는 거절 뒤 다음 판정까지의 간격이다.
 * 15초에서 시작해 두 배씩 늘고 5분에서 멈춘다.
 */
export function runnerCentralRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(
    RUNNER_CENTRAL_RETRY_BASE_MS * 2 ** exponent,
    RUNNER_CENTRAL_RETRY_MAX_MS,
  );
}

/**
 * 중앙 확인 판정을 기계 정의에서 낸다. 판정이 없으면 빈 칸이므로 던진다.
 */
export function decideRunnerCentralCheck(
  facts: RunnerCentralCheckFacts,
): RunnerCentralCheckDecision {
  const snapshot = runnerCentralCheckMachine.resolveState({
    value: "decide",
    context: {},
  });
  const [, actions] = transition(runnerCentralCheckMachine, snapshot, {
    type: "CHECK",
    ...facts,
  });
  const verdict = (actions as { type: string; params?: unknown }[]).find(
    (action) => action.type === "verdict",
  ) as VerdictAction | undefined;
  if (verdict === undefined) {
    throw new Error(`runner central check decision missing: ${JSON.stringify(facts)}`);
  }
  return verdict.params.decision;
}
