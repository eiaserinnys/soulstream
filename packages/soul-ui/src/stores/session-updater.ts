/**
 * Session Updater — 세션 상태 갱신 및 알림 큐 관리
 *
 * processEvent에서 트리 빌드 후 세션 목록 상태를 갱신하고
 * 알림 대상 이벤트를 판별하는 순수 함수.
 */

import type { SoulSSEEvent, SessionStatus } from "@shared/types";

/** 알림 대상 이벤트 타입 (모듈 스코프: 매 호출 재생성 방지) */
const NOTIFY_TYPES = new Set(["complete", "error", "intervention_sent"]);

/**
 * 이벤트가 알림 대상인지 판별합니다.
 * complete, error, intervention_sent 이벤트만 알림을 트리거합니다.
 */
export function shouldNotify(event: SoulSSEEvent): boolean {
  return NOTIFY_TYPES.has(event.type);
}

/**
 * 이벤트 타입에 따라 세션 상태를 도출합니다.
 *
 * - complete/result → "completed"
 * - error → "error"
 * - user_message/intervention_sent → "running" (resume 등 새 턴 시작)
 * - 그 외 → null (상태 변경 없음)
 */
export function deriveSessionStatus(event: SoulSSEEvent): SessionStatus | null {
  switch (event.type) {
    case "complete":
    case "result":
      return "completed";
    case "error":
      return "error";
    case "user_message":
    case "intervention_sent":
      return "running";
    default:
      return null;
  }
}
