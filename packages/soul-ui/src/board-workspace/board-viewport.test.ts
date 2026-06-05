/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";

import {
  clampBoardZoom,
  formatBoardZoom,
  getBoardGridStyle,
  getCanvasBoardPoint,
  getViewportBoardRect,
  setScrollerZoomAroundClientPoint,
} from "./board-viewport";

describe("board-viewport", () => {
  it("clamps and formats board zoom", () => {
    expect(clampBoardZoom(0.1)).toBe(0.25);
    expect(clampBoardZoom(2.5)).toBe(2);
    expect(clampBoardZoom(1.234)).toBe(1.23);
    expect(formatBoardZoom(1.25)).toBe("125%");
  });

  it("keeps grid dots in board units while softening low zoom noise", () => {
    expect(getBoardGridStyle(1).backgroundSize).toBe("20px 20px");
    expect(getBoardGridStyle(1).backgroundColor).toContain("var(--background) 96%");
    expect(getBoardGridStyle(0.25).backgroundImage).toContain("16%");
  });

  it("converts pointer coordinates through the transformed canvas", () => {
    const canvas = document.createElement("div");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 10,
      left: 20,
      top: 10,
      right: 220,
      bottom: 110,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });

    expect(getCanvasBoardPoint(120, 60, canvas, 0.5)).toEqual({ x: -9800, y: -5900 });
  });

  it("keeps the pointer-anchored board point stable while zooming", () => {
    const scroller = document.createElement("div");
    const canvas = document.createElement("div");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 500,
      bottom: 300,
      width: 500,
      height: 300,
      toJSON: () => ({}),
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: -100,
      y: -50,
      left: -100,
      top: -50,
      right: 19900,
      bottom: 11950,
      width: 20000,
      height: 12000,
      toJSON: () => ({}),
    });

    setScrollerZoomAroundClientPoint(scroller, canvas, 1, 2, 150, 100);

    expect(scroller.scrollLeft).toBe(350);
    expect(scroller.scrollTop).toBe(200);
  });

  it("reports the visible viewport in board coordinates", () => {
    expect(getViewportBoardRect({ scrollLeft: 5000, scrollTop: 3000, width: 1000, height: 500 }, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 2000,
      height: 1000,
    });
  });
});
