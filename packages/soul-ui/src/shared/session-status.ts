import type { SessionStatus } from "./session-types";

/**
 * SessionSummary가 이해하는 상태로 wire status를 정규화한다.
 *
 * soul-server phase wire는 턴 사이 상태로 "idle"을 보낼 수 있지만,
 * 세션 목록 카드의 상태 모델에서는 terminal이 아니다. 피드/폴더 카드에서는
 * 살아있는 세션으로 취급해야 하므로 running으로 접는다.
 */
export function normalizeSessionStatus(status: unknown): SessionStatus {
  switch (status) {
    case "running":
    case "completed":
    case "error":
    case "interrupted":
    case "unknown":
      return status;
    case "idle":
      return "running";
    default:
      return "unknown";
  }
}
