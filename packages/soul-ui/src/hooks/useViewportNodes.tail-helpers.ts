/**
 * useViewportNodes — tail-anchoring 초기 fetch 전략의 순수 헬퍼.
 *
 * 실효 로직을 React 외부에서 테스트 가능하게 분리한다.
 *  - computeTailRange: total 값에 따라 초기 viewport 범위 계산
 *  - runTailAnchoredFetch: probe → tail fetch 2단계 오케스트레이션
 */

import type { ViewportRange } from "./useViewportNodes";

/**
 * 세션 진입 시 초기 viewport fetch 범위.
 * DEFAULT_NODE_HEIGHT 84px 기준, 일반 모니터(1080px) 세로에
 * 약 12-13개 노드가 보이므로 50개면 4배 여유가 있다.
 * probe/tail 계산과 폴백 경로 양쪽에서 사용한다.
 */
export const INITIAL_VIEWPORT_HEIGHT = 50;

/**
 * total_subtree_height를 받아 초기 viewport 범위를 계산한다.
 *
 * 규칙:
 *  - total <= INITIAL_VIEWPORT_HEIGHT → yStart=1, yEnd=total (짧은 세션은 전체가 한 화면)
 *  - total >  INITIAL_VIEWPORT_HEIGHT → yStart=max(1, total-(N-1)), yEnd=total (tail N개)
 */
export function computeTailRange(total: number): ViewportRange {
  const clamped = Math.max(1, total);
  if (clamped <= INITIAL_VIEWPORT_HEIGHT) {
    return { yStart: 1, yEnd: clamped };
  }
  return { yStart: clamped - (INITIAL_VIEWPORT_HEIGHT - 1), yEnd: clamped };
}

/**
 * probe → tail fetch 2단계 오케스트레이션.
 *
 * 1) probe로 total_subtree_height 획득
 * 2) 성공 시 tail 범위로 doFetch 호출
 * 3) probe 실패(네트워크 에러 | HTTP not-ok) 시 기본 범위 {1,50}로 폴백
 *
 * AbortController 신호가 중간에 끊기면 조용히 종료한다.
 *
 * 순수 함수는 아니지만, fetch와 콜백을 주입받아 외부 상태에 의존하지 않는 형태로 설계되어 있다.
 * 테스트에서는 모의 fetch/콜백을 주입하여 호출 시퀀스를 검증할 수 있다.
 */
export async function runTailAnchoredFetch(params: {
  sessionKey: string;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  setTotalSubtreeHeight: (total: number) => void;
  doFetch: (range: ViewportRange) => void;
}): Promise<void> {
  const { sessionKey, fetchImpl, signal, setTotalSubtreeHeight, doFetch } =
    params;

  const probeUrl = `/api/sessions/${encodeURIComponent(sessionKey)}/events/viewport?y_min=1&y_max=1`;

  let probeRes: Response;
  try {
    probeRes = await fetchImpl(probeUrl, {
      credentials: "include",
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    if (signal.aborted) return;
    doFetch({ yStart: 1, yEnd: INITIAL_VIEWPORT_HEIGHT });
    return;
  }

  if (signal.aborted) return;

  if (!probeRes.ok) {
    doFetch({ yStart: 1, yEnd: INITIAL_VIEWPORT_HEIGHT });
    return;
  }

  const probeData = (await probeRes.json()) as {
    total_subtree_height?: number;
  };
  if (signal.aborted) return;

  // total_subtree_height는 서버 스키마상 required 필드다.
  // 누락은 서버 버그 또는 예상치 못한 응답 형태 — 조용히 1로 덮어쓰지 않고
  // 네트워크 에러·HTTP not-ok와 동일한 {1, 50} 폴백 경로로 보낸다.
  if (typeof probeData.total_subtree_height !== "number") {
    console.warn(
      "[runTailAnchoredFetch] probe 응답에 total_subtree_height 누락 → {1,50} 폴백",
    );
    doFetch({ yStart: 1, yEnd: INITIAL_VIEWPORT_HEIGHT });
    return;
  }

  const total = Math.max(1, probeData.total_subtree_height);
  setTotalSubtreeHeight(total);

  doFetch(computeTailRange(total));
}

/**
 * NodeGraph의 viewport 기반 pan-to-latest 결정 로직.
 *
 * 조건:
 *  1) 활성 세션이 존재
 *  2) viewport.nodes가 1개 이상
 *  3) 이 세션에서 아직 viewport pan을 수행하지 않음
 */
export function shouldRunViewportPan(params: {
  sessionKey: string | null | undefined;
  viewportNodesLength: number;
  lastPannedSessionKey: string | null;
}): boolean {
  if (!params.sessionKey) return false;
  if (params.viewportNodesLength === 0) return false;
  if (params.lastPannedSessionKey === params.sessionKey) return false;
  return true;
}
