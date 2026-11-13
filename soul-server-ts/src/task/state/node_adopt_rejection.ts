/**
 * 서버가 잇기 알림과 실행 등록의 거절에 싣는 사유와 그 분류의 정본이다.
 * 러너 카드(#1265)가 runner/state에 두었던 것을 노드 기계 쪽으로 옮겼다.
 * task/state는 runner/state를 import하지 않는다. runner/state와 task_executor가 이것을 부른다.
 */

/** 거절 분류다. 러너 쪽 `RunnerAdoptResponse`의 두 값과 같은 문자열이다. */
export type AdoptRejectionClass = "terminal_rejection" | "retryable_rejection";

/** 다시 될 까닭 없는 거절 사유다. */
export const TERMINAL_ADOPT_REJECTION_REASONS: readonly string[] = [
  "already_terminal",
  "session_missing",
  "owner_node_changed",
];

/**
 * 거절 사유를 분류한다. 사유 없음과 모르는 값은 옛 서버 호환으로 다시 될 수 있음이다.
 */
export function classifyRunnerAdoptRejection(
  reason: string | null | undefined,
): AdoptRejectionClass {
  if (typeof reason === "string" && TERMINAL_ADOPT_REJECTION_REASONS.includes(reason)) {
    return "terminal_rejection";
  }
  return "retryable_rejection";
}
