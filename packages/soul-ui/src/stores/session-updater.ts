/**
 * Session Updater — 채팅 이벤트 알림 정책
 *
 * chat SSE는 채팅 트리만 갱신한다. 이 모듈은 알림 대상 이벤트만 판별하며,
 * 세션 lifecycle은 sessions stream이 단독으로 갱신한다.
 */

import type { SoulSSEEvent } from "@shared/types";

/** 알림 대상 이벤트 타입 (모듈 스코프: 매 호출 재생성 방지) */
const NOTIFY_TYPES = new Set([
  "complete",
  "error",
  "intervention_sent",
  "session_notification",
  "claude_runtime_notification",
]);

/**
 * 이벤트가 알림 대상인지 판별합니다.
 * complete, error, intervention_sent 이벤트만 알림을 트리거합니다.
 */
export function shouldNotify(event: SoulSSEEvent): boolean {
  return NOTIFY_TYPES.has(event.type);
}
