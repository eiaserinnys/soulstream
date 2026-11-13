/**
 * 읽기용 세션 상태 분류 함수와 같은 뜻의 SQL 조건 조각.
 *
 * 복합 분류 함수는 두지 않는다. 호출부가 필요한 낱개 조건을 골라 쓴다.
 * SQL 조각은 별칭을 받아 그대로 WHERE에 넣을 수 있게 한다.
 */
export interface SessionClassificationRow {
  status: string | null;
  termination_reason?: string | null;
  termination_event_id?: number | null;
  review_state?: string | null;
  execution_registration_id?: string | null;
}

const ACTIVE_STATUSES = ["initializing", "running"] as const;
const TERMINAL_STATUSES = ["completed", "error", "interrupted"] as const;

export function isSessionRunning(row: SessionClassificationRow): boolean {
  return row.status === "running";
}

export function isSessionActive(row: SessionClassificationRow): boolean {
  return (ACTIVE_STATUSES as readonly (string | null)[]).includes(row.status);
}

export function isSessionTerminal(row: SessionClassificationRow): boolean {
  return (TERMINAL_STATUSES as readonly (string | null)[]).includes(row.status);
}

export function isDisconnectedInterrupted(
  row: SessionClassificationRow,
): boolean {
  return row.status === "interrupted" && row.termination_event_id == null;
}

export function hasRecordedTermination(
  row: SessionClassificationRow,
): boolean {
  return row.termination_event_id != null;
}

export function isLimitTerminated(row: SessionClassificationRow): boolean {
  const revision = row.termination_event_id;
  return row.status === "error"
    && row.termination_reason === "limit_hit"
    && typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision > 0;
}

export function isSessionReviewPending(
  row: SessionClassificationRow,
): boolean {
  return row.review_state === "needs_review";
}

export function isSessionStartupTarget(
  row: SessionClassificationRow,
): boolean {
  return row.status === "running"
    || (row.status === "initializing"
      && row.execution_registration_id == null);
}

export const SESSION_SQL_PREDICATES = {
  isSessionRunning: (alias: string) => `${alias}.status = 'running'`,
  isSessionActive: (alias: string) =>
    `${alias}.status IN ('initializing', 'running')`,
  isSessionTerminal: (alias: string) =>
    `${alias}.status IN ('completed', 'error', 'interrupted')`,
  isDisconnectedInterrupted: (alias: string) =>
    `(${alias}.status = 'interrupted' AND ${alias}.termination_event_id IS NULL)`,
  hasRecordedTermination: (alias: string) =>
    `${alias}.termination_event_id IS NOT NULL`,
  isLimitTerminated: (alias: string) =>
    `(${alias}.status = 'error' AND ${alias}.termination_reason = 'limit_hit' AND ${alias}.termination_event_id IS NOT NULL AND ${alias}.termination_event_id > 0)`,
  isSessionReviewPending: (alias: string) =>
    `${alias}.review_state = 'needs_review'`,
  isSessionStartupTarget: (alias: string) =>
    `(${alias}.status = 'running' OR (${alias}.status = 'initializing' AND ${alias}.execution_registration_id IS NULL))`,
} as const;

export type SessionClassifierName = keyof typeof SESSION_SQL_PREDICATES;

export function classifySessionRow(
  name: SessionClassifierName,
  row: SessionClassificationRow,
): boolean {
  return classifierFunctions[name](row);
}

const classifierFunctions: Record<
  SessionClassifierName,
  (row: SessionClassificationRow) => boolean
> = {
  isSessionRunning,
  isSessionActive,
  isSessionTerminal,
  isDisconnectedInterrupted,
  hasRecordedTermination,
  isLimitTerminated,
  isSessionReviewPending,
  isSessionStartupTarget,
};
