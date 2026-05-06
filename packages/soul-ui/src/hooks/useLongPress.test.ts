/**
 * useLongPress 단위 테스트.
 *
 * vitest 환경(node)에는 jsdom + @testing-library/react가 없으므로
 * React 훅 자체는 직접 렌더하지 않고, 진행률 계산 순수 함수만 검증한다.
 *
 * 훅의 timer 동작은 PROGRESS_INTERVAL_MS / Date.now()를 그대로 사용하는
 * 단순한 setInterval이므로, computeLongPressProgress가 정확하면
 * 훅의 동작 정합도 보장된다.
 */

import { describe, it, expect } from "vitest";
import { computeLongPressProgress } from "./useLongPress";

describe("computeLongPressProgress", () => {
  it("delay=1000, elapsed=0 → 0", () => {
    expect(computeLongPressProgress(0, 1000)).toBe(0);
  });

  it("delay=1000, elapsed=500 → 50", () => {
    expect(computeLongPressProgress(500, 1000)).toBe(50);
  });

  it("delay=1000, elapsed=999 → 99", () => {
    expect(computeLongPressProgress(999, 1000)).toBe(99);
  });

  it("delay=1000, elapsed=1000 → 100", () => {
    expect(computeLongPressProgress(1000, 1000)).toBe(100);
  });

  it("delay=1000, elapsed > delay → 100 (clamp)", () => {
    expect(computeLongPressProgress(2500, 1000)).toBe(100);
  });

  it("delay=1000, elapsed < 0 → 0 (clamp)", () => {
    expect(computeLongPressProgress(-50, 1000)).toBe(0);
  });

  it("delay=0이면 항상 100 (즉시 fire 의도, division by zero 방지)", () => {
    expect(computeLongPressProgress(0, 0)).toBe(100);
    expect(computeLongPressProgress(100, 0)).toBe(100);
  });

  it("delay=-100이면 항상 100 (음수 delay 방어)", () => {
    expect(computeLongPressProgress(50, -100)).toBe(100);
  });

  it("60ms 간격 진행률 시퀀스 (delay=1000): 0,6,12,...,96,100", () => {
    const series: number[] = [];
    for (let elapsed = 0; elapsed <= 1020; elapsed += 60) {
      series.push(computeLongPressProgress(elapsed, 1000));
    }
    // 첫 값 0, 마지막 값 100
    expect(series[0]).toBe(0);
    expect(series[series.length - 1]).toBe(100);
    // 단조 증가
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
    }
  });
});
