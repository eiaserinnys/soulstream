/**
 * 한 세션 줄과 한도 재개 예약 하나를 저장 상태 값으로 읽는다.
 *
 * 카드 기계(cards/state/card_state_value.ts)와 같은 꼴이다. 상태 글자는 저장
 * 칸(status)과 종료 리비전(termination_event_id), 검수 칸(review_state)에서
 * 그대로 나오며, 예약 영역은 이번 물결에서 읽기 전용 투영이다. 예약을 쓰는
 * 명령은 아직 기계에 없다.
 */
export const SESSION_STATUS_LEAVES = [
  "none",
  "initializing",
  "running",
  "completed",
  "error",
  "interrupted",
] as const;
export type SessionStatusLeaf = (typeof SESSION_STATUS_LEAVES)[number];
export type StoredSessionStatus = Exclude<SessionStatusLeaf, "none">;

export const SESSION_REVIEW_STATES = [
  "not_required",
  "needs_review",
  "acknowledged",
] as const;
export type SessionReviewState = (typeof SESSION_REVIEW_STATES)[number];

export type SessionTerminationLeaf = "none" | "recorded";
export type SessionReservationLeaf = "none" | "reserved";

export interface SessionStateValue {
  status: SessionStatusLeaf;
  termination: SessionTerminationLeaf;
  review: SessionReviewState;
  reservation: SessionReservationLeaf;
  verdict: "ready";
}

/**
 * 종료 기록이 있다는 사실만 값으로 든다. 실제 종료 사건 번호는 명령 사실이
 * 나르며 기계는 그 번호를 저장하지 않는다. 칸을 되돌릴 때 쓰는 표식 값이다.
 */
export const RECORDED_TERMINATION_REVISION = 1;

export function rowToStateValue(
  row: Record<string, any> | null,
  reservation: SessionReservationLeaf = "none",
): SessionStateValue {
  if (!row) {
    return {
      status: "none",
      termination: "none",
      review: "not_required",
      reservation,
      verdict: "ready",
    };
  }
  const status = row.status;
  if (
    typeof status !== "string"
    || status === "none"
    || !(SESSION_STATUS_LEAVES as readonly string[]).includes(status)
  ) {
    throw new Error(`알 수 없는 세션 상태: ${String(status)}`);
  }
  const review = row.review_state;
  if (!(SESSION_REVIEW_STATES as readonly string[]).includes(review)) {
    throw new Error(`알 수 없는 검수 상태: ${String(review)}`);
  }
  return {
    status: status as SessionStatusLeaf,
    termination: row.termination_event_id == null ? "none" : "recorded",
    review: review as SessionReviewState,
    reservation,
    verdict: "ready",
  };
}

export function sessionStatusLeaf(value: SessionStateValue): SessionStatusLeaf {
  return value.status;
}

/** 종료 전환 입력의 목표 상태 글자를 기계의 종료 상태 값으로 읽는다. */
export function sessionTerminalTarget(
  value: string,
): Extract<StoredSessionStatus, "completed" | "error" | "interrupted"> | null {
  return value === "completed" || value === "error" || value === "interrupted"
    ? value
    : null;
}

export function stateValueToColumns(value: SessionStateValue): {
  status: StoredSessionStatus | null;
  termination_event_id: number | null;
  review_state: SessionReviewState;
} {
  return {
    status: value.status === "none" ? null : value.status,
    termination_event_id:
      value.termination === "recorded" ? RECORDED_TERMINATION_REVISION : null,
    review_state: value.review,
  };
}
