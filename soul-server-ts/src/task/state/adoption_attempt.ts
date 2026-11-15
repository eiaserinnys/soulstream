import { isActiveTaskStatus, type Task, type TaskStatus } from "../task_models.js";

/**
 * 잇기 시도가 보낼 때의 실행 신원이다. 첫 await 전에 한 번 잡아 두고, 응답을 task에
 * 반영하기 전에 지금 task가 같은 실행인지 견준다. 기다리는 사이 그 실행이 끝나고
 * 자동 재개가 같은 Task에 새 실행을 시작하면, 늦게 온 응답은 새 실행에 닿지 않는다.
 */
export interface AdoptionAttempt {
  /**
   * 보낼 때 task에 붙어 있던 러너다. `task/state`는 `runner/`를 import하지 않으므로
   * `Task`가 싣는 타입으로 적는다(경계 시험, 카드 #1400).
   */
  readonly runner: NonNullable<Task["runner"]>;
  readonly status: TaskStatus;
  /**
   * 보낼 때의 실행 명령 번호다. 보존 러너를 다시 쓰는 새 실행은 등록 번호가 같고
   * 명령 번호만 다르므로 등록만 견주면 같은 실행으로 오인한다.
   */
  readonly executionCommandId: string | undefined;
  /**
   * 보낼 때의 실행 슬롯이다. 시동 복구 잇기는 슬롯을 첫 await 뒤에 잡으므로 이 칸을
   * 비워 슬롯 비교를 하지 않는다(비운 것과 `undefined`인 것을 구분해야 한다).
   */
  readonly executionSlot?: { readonly expected: Promise<void> | undefined };
  /** 보낼 때 `suspendedRecoveredExecutions`에 있던 항목이다. */
  readonly suspended: unknown;
  /** 실제로 보낸 등록 번호다. 중앙 세션 줄의 등록과 견준다. */
  readonly sentRegistrationId: string | undefined;
  /** 거절이 오류 종료를 올릴 때 지킬 등록 번호다. */
  readonly fenceRegistrationId: string | undefined;
}

/**
 * 잡아 둔 시도와 지금 task가 같은 실행인가.
 *
 * `suspendedNow`는 호출자가 지금 읽은 `suspendedRecoveredExecutions` 항목이다.
 * 활성 상태였던 실행은 비활성으로 내려갔는지도 본다(끝난 실행의 응답을 반영하지 않는다).
 */
export function adoptionTargetsSameExecution(
  task: Task,
  attempt: AdoptionAttempt,
  suspendedNow: unknown,
): boolean {
  if (task.runner !== attempt.runner) return false;
  if (
    attempt.executionSlot !== undefined
    && task.executionPromise !== attempt.executionSlot.expected
  ) return false;
  if (suspendedNow !== attempt.suspended) return false;
  if (task.executionRegistration?.executionCommandId !== attempt.executionCommandId) return false;
  return !isActiveTaskStatus(attempt.status) || isActiveTaskStatus(task.status);
}
