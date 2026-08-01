/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import {
  findFirstVisuallyIntersectingItemKey,
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

describe("findFirstVisuallyIntersectingItemKey", () => {
  it("800px 위 overscan 행을 건너뛰고 실제 viewport 첫 교차 행을 고른다", () => {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(100, 300);
    scroller.append(
      marker("overscan", -700, -660),
      marker("above", 60, 100),
      marker("first-visible", 80, 120),
      marker("second-visible", 120, 160),
      marker("below", 300, 340),
    );

    expect(findFirstVisuallyIntersectingItemKey(scroller)).toBe("first-visible");
    expect(measureFirstVisuallyIntersectingItem(scroller)).toEqual({
      key: "first-visible",
      offset: -20,
      scrollHeight: 0,
      scrollTop: 0,
    });
  });

  it("DOM 순서가 달라도 가장 위에서 교차하는 행을 고른다", () => {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(100, 300);
    scroller.append(
      marker("second", 140, 180),
      marker("first", 110, 150),
    );

    expect(findFirstVisuallyIntersectingItemKey(scroller)).toBe("first");
  });

  it("교차 행이 없으면 null을 반환한다", () => {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(100, 300);
    scroller.append(marker("above", 0, 100), marker("below", 300, 340));

    expect(findFirstVisuallyIntersectingItemKey(scroller)).toBeNull();
  });

  it("stable key 행의 현재 viewport offset을 overscan 여부와 무관하게 측정한다", () => {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(100, 300);
    scroller.append(marker("overscan-anchor", 20, 60));

    expect(measureChatItemOffset(scroller, "overscan-anchor")).toBe(-80);
    expect(measureChatItemOffset(scroller, "missing")).toBeNull();
  });
});
