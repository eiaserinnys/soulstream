/**
 * useSessionListProvider 내부에서 사용되는 순수 resume 헬퍼.
 *
 * Last-Event-ID + instance_id 추적 책임을 hook 외부 순수 함수로 노출하여
 * 인터페이스가 테스트 표면이 되도록 한다.
 */

import type {
  ReplayGapStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";

const DEFAULT_PAGE_SIZE = 50;

/**
 * 카탈로그 SSE URL 빌더 (Last-Event-ID resume + instance_id 추적용 쿼리 부착).
 *
 * 브라우저 EventSource는 표준상 `Last-Event-ID` 헤더를 자동 송출하지만 헤더 주입이
 * 불가능하므로 본 패턴은 `?lastEventId=` 쿼리로 통일한다 (서버는 헤더와 쿼리 둘 다
 * 받지만 헤더 우선). 빈/undefined 값은 쿼리에서 자연 제거.
 */
export function buildCatalogStreamUrl(
  lastEventId?: string,
  instanceId?: string,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(DEFAULT_PAGE_SIZE));
  if (lastEventId) params.set("lastEventId", lastEventId);
  if (instanceId) params.set("instanceId", instanceId);
  return `/api/sessions/stream?${params.toString()}`;
}

/**
 * stream_meta 수신 시의 책임:
 * - 첫 수신 (이전 instance_id 없음): 단순 기록. 첫 SSE 사이클은 깨끗한 상태이므로 refetch 불필요.
 * - instance_id 변경 (orch 재시작/리더 변경): ring buffer 단절이므로 풀 refetch + lastEventId를
 *   서버 latest_id로 동기화.
 * - instance_id 동일: noop (이미 정상 resume 중).
 *
 * 반환: 갱신해야 할 다음 상태와 refetch 필요 여부. hook 외부에서 ref 갱신/queryRefetch 호출.
 */
export interface ResumeStateUpdate {
  nextInstanceId: string;
  nextLastEventId: string | undefined;
  shouldRefetch: boolean;
}

export function reconcileStreamMeta(
  event: StreamMetaStreamEvent,
  prev: { instanceId?: string; lastEventId?: string },
): ResumeStateUpdate | null {
  if (!event.instance_id) return null;
  if (prev.instanceId && prev.instanceId !== event.instance_id) {
    return {
      nextInstanceId: event.instance_id,
      nextLastEventId: String(event.latest_id ?? 0),
      shouldRefetch: true,
    };
  }
  return {
    nextInstanceId: event.instance_id,
    nextLastEventId: prev.lastEventId,
    shouldRefetch: false,
  };
}

/**
 * replay_gap 수신: ring buffer 부족 — 풀 refetch + lastEventId를 서버 latest_id로 끌어올린다.
 */
export function reconcileReplayGap(
  event: ReplayGapStreamEvent,
): { nextLastEventId: string; shouldRefetch: true } {
  return {
    nextLastEventId: String(event.latest_id ?? 0),
    shouldRefetch: true,
  };
}
