import { transition } from "xstate";

import { isActiveTaskStatus, type Task } from "../task_models.js";
import {
  nodeExecutionMachine,
  type NodeExecutionFacts,
  type NodeExecutionPhase,
  type NodeRetentionKind,
} from "./node_execution_machine.js";

/** 투영이 읽는 Task 필드다. */
export type NodeExecutionTaskFields = Pick<
  Task,
  | "status"
  | "runner"
  | "executionRegistration"
  | "runnerTerminalFact"
  | "runnerRetainedForDetachedWork"
  | "runnerReleaseClaim"
  | "hydratedFromDb"
  | "terminationEventRecorded"
  | "runnerIsOfflineReplay"
  | "executionActivation"
  | "executionPromise"
>;

export interface NodeExecutionFactsOptions {
  /**
   * 보유 종류다. Task에는 엔진 종류가 없어 호출자가 준다.
   * 보유 표지가 서 있는데 종류를 주지 않으면 클로드의 남은 백그라운드 작업으로 본다.
   */
  retentionKind?: Exclude<NodeRetentionKind, "none">;
  /**
   * 멈춤 장벽이 올라 있는가. Task에는 넘기기 장벽과 멈춤 장벽을 가르는 표지가 없어
   * 호출자가 준다.
   */
  stopRequested?: boolean;
}

/** Task 필드를 판정 입력으로 모은다. */
export function nodeExecutionFactsFromTask(
  task: NodeExecutionTaskFields,
  options: NodeExecutionFactsOptions = {},
): NodeExecutionFacts {
  const retained = task.runnerRetainedForDetachedWork === true;
  return {
    active: isActiveTaskStatus(task.status),
    terminalRecorded: !isActiveTaskStatus(task.status)
      && task.terminationEventRecorded === true,
    hasRunner: task.runner !== undefined,
    offlineReplay: task.runnerIsOfflineReplay === true,
    hasStartBarrier: task.executionActivation !== undefined
      || task.executionPromise !== undefined,
    hasRegistration: task.executionRegistration !== undefined,
    runnerTerminalFact: task.runnerTerminalFact ?? "none",
    retention: retained ? (options.retentionKind ?? "claude_background") : "none",
    releasing: task.runnerReleaseClaim !== undefined,
    hydratedFromDb: task.hydratedFromDb === true,
    stopRequested: options.stopRequested === true,
  };
}

/** 판정 입력을 노드 실행 상태 하나로 투영한다. 맞는 상태가 없으면 빈 칸이므로 던진다. */
export function projectNodeExecutionPhase(
  facts: NodeExecutionFacts,
): NodeExecutionPhase {
  const snapshot = nodeExecutionMachine.resolveState({
    value: "project",
    context: {},
  });
  const [next] = transition(nodeExecutionMachine, snapshot, {
    type: "PROJECT",
    ...facts,
  });
  if (next.value === "project") {
    throw new Error(`node execution phase missing: ${JSON.stringify(facts)}`);
  }
  return next.value as NodeExecutionPhase;
}

/** Task에서 곧바로 노드 실행 상태를 낸다. */
export function nodeExecutionPhaseOfTask(
  task: NodeExecutionTaskFields,
  options?: NodeExecutionFactsOptions,
): NodeExecutionPhase {
  return projectNodeExecutionPhase(nodeExecutionFactsFromTask(task, options));
}
