import { transition } from "xstate";

import {
  runnerHandleMachine,
  type RunnerHandleAction,
  type RunnerHandleFacts,
} from "./runner_handle_machine.js";

interface VerdictAction {
  type: "verdict";
  params: { action: RunnerHandleAction };
}

/**
 * 복구 처리 조치를 기계 정의에서 낸다. 판정이 없으면 빈 칸이므로 던진다.
 */
export function decideRunnerHandle(facts: RunnerHandleFacts): RunnerHandleAction {
  const snapshot = runnerHandleMachine.resolveState({
    value: "decide",
    context: {},
  });
  const [, actions] = transition(runnerHandleMachine, snapshot, {
    type: "HANDLE",
    ...facts,
  });
  const verdict = (actions as { type: string; params?: unknown }[]).find(
    (action) => action.type === "verdict",
  ) as VerdictAction | undefined;
  if (verdict === undefined) {
    throw new Error(`runner handle decision missing: ${JSON.stringify(facts)}`);
  }
  return verdict.params.action;
}
