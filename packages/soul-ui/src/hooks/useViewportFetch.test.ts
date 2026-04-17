/**
 * useViewportFetch / createViewportThrottle 테스트
 *
 * leading-edge + trailing-edge 트로틀 상태 머신 검증.
 * React를 거치지 않고 createViewportThrottle을 직접 테스트한다
 * (훅은 ref + unmount cleanup을 얹은 얇은 래퍼일 뿐).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createViewportThrottle } from "./useViewportFetch";

interface TestViewport {
  yStart: number;
  yEnd: number;
}

describe("createViewportThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leading-edge: 첫 request()는 즉시 fetcher를 호출한다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ yStart: 0, yEnd: 100 });
  });

  it("쿨다운 중 추가 request()는 즉시 호출되지 않고 대기한다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 쿨다운 구간 (0~200ms): 추가 request는 발사되지 않는다
    vi.advanceTimersByTime(50);
    throttle.request({ yStart: 10, yEnd: 110 });
    vi.advanceTimersByTime(50);
    throttle.request({ yStart: 20, yEnd: 120 });

    expect(fetcher).toHaveBeenCalledTimes(1); // 여전히 1회
  });

  it("trailing-edge: 쿨다운 종료 시 **마지막** 대기 viewport로 한 번 더 호출한다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 }); // leading
    throttle.request({ yStart: 10, yEnd: 110 }); // 대기 → 버려짐
    throttle.request({ yStart: 20, yEnd: 120 }); // 대기 → 최종값

    // 쿨다운 종료
    vi.advanceTimersByTime(200);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ yStart: 20, yEnd: 120 });
  });

  it("쿨다운 중 추가 request가 없으면 trailing 호출이 발생하지 않는다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 });
    vi.advanceTimersByTime(200);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("trailing 발사 후 다시 쿨다운이 시작되어 후속 request는 또 대기한다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 }); // 1회차 leading
    throttle.request({ yStart: 10, yEnd: 110 }); // 대기
    vi.advanceTimersByTime(200); // trailing 발사 (2회차) + 재쿨다운

    expect(fetcher).toHaveBeenCalledTimes(2);

    // 재쿨다운 중 추가 request는 대기
    throttle.request({ yStart: 20, yEnd: 120 });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // 재쿨다운 종료 → 마지막 viewport로 trailing (3회차)
    vi.advanceTimersByTime(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenLastCalledWith({ yStart: 20, yEnd: 120 });
  });

  it("재쿨다운 후 대기 request가 없으면 idle로 복귀한다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 });
    throttle.request({ yStart: 10, yEnd: 110 });
    vi.advanceTimersByTime(200); // trailing (2회차), 재쿨다운 시작
    vi.advanceTimersByTime(200); // 재쿨다운 종료, 대기 없음

    expect(fetcher).toHaveBeenCalledTimes(2);

    // idle 상태: 다음 request는 즉시 발사
    throttle.request({ yStart: 30, yEnd: 130 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenLastCalledWith({ yStart: 30, yEnd: 130 });
  });

  it("cancel()은 pending timer를 해제하여 trailing 발사를 막는다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 }); // leading
    throttle.request({ yStart: 10, yEnd: 110 }); // 대기

    throttle.cancel();
    vi.advanceTimersByTime(500);

    expect(fetcher).toHaveBeenCalledTimes(1); // trailing이 발사되지 않았음
  });

  it("cancel() 후 새 request는 다시 leading-edge로 동작한다", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 });
    throttle.cancel();

    throttle.request({ yStart: 50, yEnd: 150 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ yStart: 50, yEnd: 150 });
  });

  it("fetcher가 Promise를 반환해도 트로틀이 대기하지 않는다 (fire-and-forget)", () => {
    let resolve: (() => void) | null = null;
    const fetcher = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const throttle = createViewportThrottle<TestViewport>(fetcher, 200);

    throttle.request({ yStart: 0, yEnd: 100 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Promise가 resolve되지 않은 상태에서도 쿨다운은 시간 기준으로 진행된다
    throttle.request({ yStart: 10, yEnd: 110 });
    vi.advanceTimersByTime(200);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // cleanup
    resolve?.();
  });

  it("throttleMs 0도 동작한다 (사실상 debounce 없음)", () => {
    const fetcher = vi.fn();
    const throttle = createViewportThrottle<TestViewport>(fetcher, 0);

    throttle.request({ yStart: 0, yEnd: 100 });
    throttle.request({ yStart: 10, yEnd: 110 });
    vi.advanceTimersByTime(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
