/**
 * useViewportNodes tail-anchoring 헬퍼 단위 테스트.
 *
 * Phase 2 카드의 5개 검증 케이스 중 probe/tail fetch, 짧은 세션, probe 폴백,
 * 세션 전환 취소를 순수 함수 레벨에서 커버한다.
 *  - 테스트 1: probe → tail fetch (total=200 → yStart=151, yEnd=200)
 *  - 테스트 2: 짧은 세션 (total=30 → yStart=1, yEnd=30)
 *  - 테스트 3: probe 네트워크 에러 → {1, 50} 폴백
 *  - 테스트 3-1: probe HTTP not-ok → {1, 50} 폴백
 *  - 테스트 4: 세션 전환 중 abort → 2단계 doFetch 미호출
 *  - 테스트 5: NodeGraph viewport pan 결정
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeTailRange,
  runTailAnchoredFetch,
  shouldRunViewportPan,
} from "./useViewportNodes.tail-helpers";

describe("computeTailRange", () => {
  it("total=200 → {yStart:151, yEnd:200}", () => {
    expect(computeTailRange(200)).toEqual({ yStart: 151, yEnd: 200 });
  });

  it("total=50 (경계) → {yStart:1, yEnd:50}", () => {
    expect(computeTailRange(50)).toEqual({ yStart: 1, yEnd: 50 });
  });

  it("total=30 (짧은 세션) → {yStart:1, yEnd:30}", () => {
    expect(computeTailRange(30)).toEqual({ yStart: 1, yEnd: 30 });
  });

  it("total=51 (50 초과 경계) → {yStart:2, yEnd:51}", () => {
    expect(computeTailRange(51)).toEqual({ yStart: 2, yEnd: 51 });
  });

  it("total=0 또는 음수 → 최소 1로 클램프", () => {
    expect(computeTailRange(0)).toEqual({ yStart: 1, yEnd: 1 });
    expect(computeTailRange(-10)).toEqual({ yStart: 1, yEnd: 1 });
  });
});

/** JSON 응답 Response 모의 */
function mockJsonResponse(body: unknown, init?: ResponseInit): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    ...init,
  } as unknown as Response;
}

function mockErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe("runTailAnchoredFetch", () => {
  it("테스트 1: probe 성공 (total=200) → tail 범위 yStart=151, yEnd=200 doFetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      mockJsonResponse({ total_subtree_height: 200 }),
    );
    const setTotal = vi.fn();
    const doFetch = vi.fn();
    const controller = new AbortController();

    await runTailAnchoredFetch({
      sessionKey: "sess-A",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    // probe URL 확인
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "/api/sessions/sess-A/events/viewport?y_min=1&y_max=1",
    );

    // setTotalSubtreeHeight 호출
    expect(setTotal).toHaveBeenCalledWith(200);

    // doFetch tail range 호출
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith({ yStart: 151, yEnd: 200 });
  });

  it("테스트 2: 짧은 세션 (total=30) → yStart=1, yEnd=30 doFetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      mockJsonResponse({ total_subtree_height: 30 }),
    );
    const setTotal = vi.fn();
    const doFetch = vi.fn();
    const controller = new AbortController();

    await runTailAnchoredFetch({
      sessionKey: "sess-short",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    expect(setTotal).toHaveBeenCalledWith(30);
    expect(doFetch).toHaveBeenCalledWith({ yStart: 1, yEnd: 30 });
  });

  it("테스트 3: probe 네트워크 에러 → {yStart:1, yEnd:50} 폴백 호출", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("network fail"));
    const setTotal = vi.fn();
    const doFetch = vi.fn();
    const controller = new AbortController();

    await runTailAnchoredFetch({
      sessionKey: "sess-A",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    expect(setTotal).not.toHaveBeenCalled();
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith({ yStart: 1, yEnd: 50 });
  });

  it("테스트 3-1: probe HTTP not-ok → {yStart:1, yEnd:50} 폴백 호출", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(mockErrorResponse(500));
    const setTotal = vi.fn();
    const doFetch = vi.fn();
    const controller = new AbortController();

    await runTailAnchoredFetch({
      sessionKey: "sess-A",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    expect(setTotal).not.toHaveBeenCalled();
    expect(doFetch).toHaveBeenCalledWith({ yStart: 1, yEnd: 50 });
  });

  it("테스트 4: probe 응답 전 abort → doFetch가 호출되지 않는다", async () => {
    // probe fetch를 반환 전에 abort 처리하도록 — AbortError 발생
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const setTotal = vi.fn();
    const doFetch = vi.fn();

    const p = runTailAnchoredFetch({
      sessionKey: "sess-A",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    // 세션 전환 시뮬레이션
    controller.abort();
    await p;

    expect(setTotal).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("에지: total_subtree_height가 응답에서 누락되면 {1,50} 폴백 (서버 스키마 required 위반 방어)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(mockJsonResponse({}));
    const setTotal = vi.fn();
    const doFetch = vi.fn();
    const controller = new AbortController();

    await runTailAnchoredFetch({
      sessionKey: "sess-A",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    // 누락은 조용히 total=1로 덮어쓰지 않는다 — 기존 store 값을 건드리지 않는다.
    expect(setTotal).not.toHaveBeenCalled();
    // 네트워크 에러와 동일한 폴백 경로.
    expect(doFetch).toHaveBeenCalledWith({ yStart: 1, yEnd: 50 });
  });

  it("에지: probe 응답 json() 파싱 중 abort → doFetch 미호출", async () => {
    // probe 자체는 성공 Response지만, json() 직전/중에 signal이 abort되는 경로.
    // 사용자가 probe 응답 수신 직후 세션을 전환하면 도달한다.
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        // json() 진행 중 abort 시뮬레이션
        controller.abort();
        return { total_subtree_height: 200 };
      },
    } as unknown as Response);
    const setTotal = vi.fn();
    const doFetch = vi.fn();

    await runTailAnchoredFetch({
      sessionKey: "sess-A",
      fetchImpl,
      signal: controller.signal,
      setTotalSubtreeHeight: setTotal,
      doFetch,
    });

    expect(setTotal).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("shouldRunViewportPan", () => {
  it("테스트 5: 활성 세션 + viewport nodes 1개 이상 + 아직 pan 안 함 → true (완료된 세션 포함)", () => {
    expect(
      shouldRunViewportPan({
        sessionKey: "sess-completed",
        viewportNodesLength: 10,
        lastPannedSessionKey: null,
      }),
    ).toBe(true);
  });

  it("sessionKey가 null → false", () => {
    expect(
      shouldRunViewportPan({
        sessionKey: null,
        viewportNodesLength: 10,
        lastPannedSessionKey: null,
      }),
    ).toBe(false);
  });

  it("viewport nodes가 비어 있으면 → false (아직 로드 전)", () => {
    expect(
      shouldRunViewportPan({
        sessionKey: "sess-A",
        viewportNodesLength: 0,
        lastPannedSessionKey: null,
      }),
    ).toBe(false);
  });

  it("이미 이 세션에 대해 pan을 수행했다면 → false (세션당 1회)", () => {
    expect(
      shouldRunViewportPan({
        sessionKey: "sess-A",
        viewportNodesLength: 50,
        lastPannedSessionKey: "sess-A",
      }),
    ).toBe(false);
  });

  it("세션 전환: 이전 세션에서 pan했어도 새 세션에선 → true", () => {
    expect(
      shouldRunViewportPan({
        sessionKey: "sess-B",
        viewportNodesLength: 10,
        lastPannedSessionKey: "sess-A",
      }),
    ).toBe(true);
  });
});
