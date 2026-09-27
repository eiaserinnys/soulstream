/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import {
  hasFilledHistoryViewport,
  measureChatItemOffset,
  measureFirstVisuallyIntersectingItem,
} from "./ChatView.viewport-geometry";

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 320,
    width: 320,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function marker(key: string, top: number, bottom: number): HTMLElement {
  const outer = document.createElement("div");
  outer.dataset.chatItemKey = key;
  const row = document.createElement("div");
  row.getBoundingClientRect = () => rect(top, bottom);
  outer.append(row);
  return outer;
}

describe("measureFirstVisuallyIntersectingItem", () => {
  it("800px 위 overscan 행을 건너뛰고 실제 viewport 첫 교차 행을 측정한다", () => {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(100, 300);
    scroller.append(
      marker("overscan", -700, -660),
      marker("above", 60, 100),
      marker("first-visible", 80, 120),
      marker("second-visible", 120, 160),
      marker("below", 300, 340),
    );

    expect(measureFirstVisuallyIntersectingItem(scroller)).toEqual({
      key: "first-visible",
      offset: -20,
      scrollHeight: 0,
      scrollTop: 0,
    });
  });

  it("stable key 행의 현재 viewport offset을 overscan 여부와 무관하게 측정한다", () => {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(100, 300);
    scroller.append(marker("overscan-anchor", 20, 60));

    expect(measureChatItemOffset(scroller, "overscan-anchor")).toBe(-80);
    expect(measureChatItemOffset(scroller, "missing")).toBeNull();
  });
});

describe("hasFilledHistoryViewport", () => {
  it("이벤트 수가 아니라 공개 scroller geometry와 여유값으로만 판정한다", () => {
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 800 },
    });

    expect(hasFilledHistoryViewport(scroller, 200)).toBe(false);

    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 801,
    });
    expect(hasFilledHistoryViewport(scroller, 200)).toBe(true);
  });

  it("clientHeight가 아직 0인 scroller는 측정 준비 전으로 취급한다", () => {
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 0 },
      scrollHeight: { configurable: true, value: 1_000 },
    });

    expect(hasFilledHistoryViewport(scroller, 200)).toBeNull();
  });
});
