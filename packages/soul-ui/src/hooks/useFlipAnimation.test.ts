/**
 * useFlipAnimation.getOrCreateRefCallback 테스트
 *
 * ref callback identity 안정화 헬퍼 검증.
 * React를 거치지 않고 순수 헬퍼를 직접 테스트한다
 * (훅은 useRef + useCallback + useLayoutEffect를 얹은 얇은 래퍼일 뿐).
 *
 * 회귀 방지 대상:
 *   - 이전 구현의 setRef가 `el.style.transform = "translateY(0)"`를 강제 리셋하여
 *     useLayoutEffect의 Invert 단계가 덮어씌워지던 버그
 *   - inline ref callback identity 불안정으로 매 렌더마다 detach/attach가 반복되던 현상
 */

import { describe, it, expect } from "vitest";
import { getOrCreateRefCallback } from "./useFlipAnimation";

describe("getOrCreateRefCallback", () => {
  it("같은 id에 대해 동일한 callback 인스턴스를 반환한다 (identity stability)", () => {
    const cache = new Map<string, (el: HTMLElement | null) => void>();
    const itemRefs = new Map<string, HTMLElement>();

    const cb1 = getOrCreateRefCallback(cache, itemRefs, "session-1");
    const cb2 = getOrCreateRefCallback(cache, itemRefs, "session-1");
    const cb3 = getOrCreateRefCallback(cache, itemRefs, "session-1");

    expect(cb1).toBe(cb2);
    expect(cb2).toBe(cb3);
  });

  it("다른 id에 대해서는 서로 다른 callback을 반환한다", () => {
    const cache = new Map<string, (el: HTMLElement | null) => void>();
    const itemRefs = new Map<string, HTMLElement>();

    const cb1 = getOrCreateRefCallback(cache, itemRefs, "session-1");
    const cb2 = getOrCreateRefCallback(cache, itemRefs, "session-2");

    expect(cb1).not.toBe(cb2);
  });

  it("callback 호출 시 el을 itemRefs에 등록한다", () => {
    const cache = new Map<string, (el: HTMLElement | null) => void>();
    const itemRefs = new Map<string, HTMLElement>();
    const el = { tagName: "DIV" } as unknown as HTMLElement;

    const cb = getOrCreateRefCallback(cache, itemRefs, "session-1");
    cb(el);

    expect(itemRefs.get("session-1")).toBe(el);
  });

  it("callback을 null로 호출하면 itemRefs에서 제거한다", () => {
    const cache = new Map<string, (el: HTMLElement | null) => void>();
    const itemRefs = new Map<string, HTMLElement>();
    const el = { tagName: "DIV" } as unknown as HTMLElement;

    const cb = getOrCreateRefCallback(cache, itemRefs, "session-1");
    cb(el);
    expect(itemRefs.has("session-1")).toBe(true);

    cb(null);
    expect(itemRefs.has("session-1")).toBe(false);
  });

  it("el 등록 시 el.style.transform을 건드리지 않는다 (FLIP Invert 보호)", () => {
    const cache = new Map<string, (el: HTMLElement | null) => void>();
    const itemRefs = new Map<string, HTMLElement>();

    // useLayoutEffect의 Invert 단계가 이미 translateY(42px)를 설정한 상태를 가정
    const el = {
      tagName: "DIV",
      style: { transform: "translateY(42px)" },
    } as unknown as HTMLElement;

    const cb = getOrCreateRefCallback(cache, itemRefs, "session-1");
    cb(el);

    // 이전 setRef 구현은 이 지점에서 "translateY(0)"으로 덮어써
    // 다음 rAF에서 Play가 delta를 해석할 수 없게 만들었다.
    expect(el.style.transform).toBe("translateY(42px)");
  });
});
