import { transition } from "xstate";

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

/** 다시 될 까닭 없는 잇기 거절 사유다. */
export const TERMINAL_ADOPT_REJECTION_REASONS: readonly string[] = [
  "already_terminal",
  "session_missing",
  "owner_node_changed",
];

export const RUNNER_CENTRAL_RETRY_BASE_MS = 15_000;
export const RUNNER_CENTRAL_RETRY_MAX_MS = 300_000;

/**
 * 잇기 거절 사유를 응답으로 가른다. 사유 없음과 모르는 값은 다시 될 수 있음이다.
 */
export function classifyRunnerAdoptRejection(
  reason: string | null | undefined,
): RunnerAdoptResponse {
  if (typeof reason === "string" && TERMINAL_ADOPT_REJECTION_REASONS.includes(reason)) {
    return "terminal_rejection";
  }
  return "retryable_rejection";
}

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
