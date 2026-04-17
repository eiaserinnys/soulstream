/**
 * useViewportFetch — 뷰포트 변경을 200ms 트로틀로 병합하여 서버에 fetch 요청을 보낸다. (Phase 3)
 *
 * 설계 결정:
 * - **RAF 대신 setTimeout 200ms**: 뷰포트 API 호출은 네트워크 비용이 크므로 프레임당 1회(~16ms)는 과도하다.
 *   200ms는 사용자가 드래그를 마친 직후 한 번만 호출되게 하면서 체감 지연이 없는 값이다.
 * - **leading-edge + trailing-edge**: 처음 트리거는 즉시 호출 (leading), 호출 중 추가 트리거가 오면
 *   200ms 쿨다운 후 마지막 값으로 한 번 더 호출 (trailing).
 * - **unmount cleanup 필수**: pending timer를 clear하지 않으면 unmount 후 setState가 호출되어 warning 발생.
 * - **createViewportThrottle 분리**: React 바깥에서 단위 테스트 가능하도록 순수 상태 머신으로 분리.
 *   훅은 얇은 래퍼 (ref + unmount cleanup)만 담당한다.
 *
 * 사용 예:
 *   const { request } = useViewportFetch(async (viewport) => {
 *     const res = await fetch(`/sessions/${id}/events/viewport?${qs(viewport)}`);
 *     store.applyViewport(await res.json());
 *   });
 *   // onMoveEnd 등에서 request({ yStart, yEnd, zoom }) 호출
 */

import { useEffect, useMemo, useRef } from "react";

/** Throttle cooldown (ms) — 뷰포트 드래그 종료 후 한 번만 fetch되도록 병합한다 */
export const VIEWPORT_THROTTLE_MS = 200;

export interface UseViewportFetchOptions {
  /** Throttle 쿨다운 오버라이드 (테스트용) */
  throttleMs?: number;
}

export interface ViewportThrottle<TViewport> {
  request: (viewport: TViewport) => void;
  cancel: () => void;
}

/**
 * 뷰포트 fetch 트로틀러 (React-free).
 *
 * 상태 머신:
 *   idle ──request──> fire(leading) + cooldown 시작
 *   cooldown ──request──> pending에 저장 (마지막 값만 유지)
 *   cooldown ──timer 만료──> pending 있으면 fire(trailing) + cooldown 재시작, 없으면 idle
 *
 * @param fetcher 실제 서버 요청을 수행하는 함수 (void 또는 Promise<void> 반환).
 *                동기 예외는 throw되지 않도록 내부에서 처리한다 (fire-and-forget).
 * @param throttleMs 쿨다운 ms.
 */
export function createViewportThrottle<TViewport>(
  fetcher: (viewport: TViewport) => void | Promise<void>,
  throttleMs: number,
): ViewportThrottle<TViewport> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cooldown = false;
  let pending: { viewport: TViewport } | null = null;

  const fire = (viewport: TViewport) => {
    // fetcher가 Promise를 반환해도 대기하지 않는다 (UI 블로킹 방지)
    void fetcher(viewport);
  };

  const startCooldown = () => {
    cooldown = true;
    timer = setTimeout(() => {
      timer = null;
      cooldown = false;
      // 쿨다운 중 대기한 trailing viewport가 있으면 즉시 발사 후 다시 쿨다운
      if (pending !== null) {
        const { viewport } = pending;
        pending = null;
        fire(viewport);
        startCooldown();
      }
    }, throttleMs);
  };

  const request = (viewport: TViewport) => {
    if (cooldown) {
      // 쿨다운 중: 마지막 viewport만 저장 (중간값은 버린다 — trailing only last)
      pending = { viewport };
      return;
    }
    // leading-edge: 즉시 발사 후 쿨다운 시작
    fire(viewport);
    startCooldown();
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    cooldown = false;
    pending = null;
  };

  return { request, cancel };
}

/**
 * 뷰포트 fetch 트로틀러 훅.
 *
 * @param fetcher 실제 서버 요청을 수행하는 async 함수. 트로틀이 풀린 직후 호출된다.
 * @returns request: 뷰포트 변경을 알리는 트리거. cancel: pending 트리거를 취소.
 */
export function useViewportFetch<TViewport>(
  fetcher: (viewport: TViewport) => void | Promise<void>,
  options: UseViewportFetchOptions = {},
): ViewportThrottle<TViewport> {
  const throttleMs = options.throttleMs ?? VIEWPORT_THROTTLE_MS;

  // fetcher의 최신 참조를 유지하되, 트로틀 인스턴스는 throttleMs가 바뀔 때만 재생성한다
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const throttle = useMemo(
    () =>
      createViewportThrottle<TViewport>(
        (viewport) => fetcherRef.current(viewport),
        throttleMs,
      ),
    [throttleMs],
  );

  // unmount / throttleMs 변경 시 pending timer를 반드시 해제한다
  useEffect(() => {
    return () => throttle.cancel();
  }, [throttle]);

  return throttle;
}
