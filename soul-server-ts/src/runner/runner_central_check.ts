import { isTerminalTaskStatus, type Task } from "../task/task_models.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import type { RunnerCentralLookup } from "./state/runner_central_check_machine.js";

/** 중앙 세션 한 줄에서 중앙 확인이 읽는 칸만 남긴다. */
export interface RunnerCentralSessionRow {
  node_id: string | null;
  status: string | null;
}

const CENTRAL_ACTIVE_STATUSES: readonly string[] = ["initializing", "running"];

/**
 * 중앙 세션 한 줄을 다섯 가지 결과로 가른다.
 * 소유 노드가 다르면 이 노드의 러너가 살아 있어도 활성으로 치지 않는다.
 */
export function classifyRunnerCentralLookup(
  row: RunnerCentralSessionRow | null,
  nodeId: string,
): RunnerCentralLookup {
  if (row === null) return "missing";
  if (row.node_id !== null && row.node_id !== nodeId) return "owner_node_changed";
  if (row.status !== null && CENTRAL_ACTIVE_STATUSES.includes(row.status)) {
    return "active";
  }
  return "inactive";
}

/** 종료 확정이면서 정상 보유(백그라운드 작업 보유 또는 유효한 해제 청구)인가. */
export function terminalRetainedForRegistration(
  task: Task,
  registration: RunnerRegistration,
): boolean {
  if (!hasRecordedTerminal(task)) return false;
  if (task.runnerRetainedForDetachedWork === true) return true;
  const claim = task.runnerReleaseClaim;
  return claim !== undefined
    && claim.registrationId === registration.registrationId
    && claim.runner === task.runner;
}

/**
 * 이 실행의 등록 적용 응답을 받았고 턴을 도는 중인가.
 *
 * task.status 대신 붙은 러너의 소유와 활성 실행으로 본다. 서버가 거절한
 * 응답으로 정본 투영을 덮어써도 러너가 살아 있는 턴을 놓치지 않기 위해서다.
 * 오프라인 재생은 살아 있는 턴이 아니므로 제외한다.
 */
export function registrationAppliedAndTurnRunning(
  task: Task,
  registration: RunnerRegistration,
): boolean {
  const runner = task.runner;
  if (!runner) return false;
  if (runner.dispatcher.registrationId() !== registration.registrationId) return false;
  if (runner.dispatcher.isClosed?.() === true) return false;
  if (task.runnerIsOfflineReplay === true) return false;
  if (task.executionRegistration?.registrationId !== registration.registrationId) {
    return false;
  }
  return runner.dispatcher.hasActiveExecution() === true;
}

function hasRecordedTerminal(task: Task): boolean {
  return isTerminalTaskStatus(task.status)
    && task.terminationEventRecorded === true
    && typeof task.terminalEventId === "number"
    && Number.isSafeInteger(task.terminalEventId)
    && task.terminalEventId > 0;
}
