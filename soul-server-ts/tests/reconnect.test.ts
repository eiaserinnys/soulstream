import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReconnectPolicy } from "../src/upstream/reconnect.js";

describe("ReconnectPolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("기본 정책: initial 3s, max 60s, ×2 (Python upstream/reconnect.py 등가)", () => {
    const p = new ReconnectPolicy();
    expect(p.currentDelaySeconds).toBe(3.0);
    expect(p.attempt).toBe(0);
  });

  it("wait 호출 시 attempt 증가 + delay 진행 (3→6→12→24→48→60→60)", async () => {
    const p = new ReconnectPolicy();
    const expectedSequence = [3, 6, 12, 24, 48, 60, 60];

    for (let i = 0; i < expectedSequence.length; i++) {
      const expectedDelay = expectedSequence[i]!;
      expect(p.currentDelaySeconds).toBe(expectedDelay);

      const promise = p.wait();
      await vi.advanceTimersByTimeAsync(expectedDelay * 1000);
      await promise;

      expect(p.attempt).toBe(i + 1);
    }
  });

  it("reset이 currentDelay와 attempt를 초기화", async () => {
    const p = new ReconnectPolicy();

    // 두 번 wait
    const w1 = p.wait();
    await vi.advanceTimersByTimeAsync(3000);
    await w1;
    const w2 = p.wait();
    await vi.advanceTimersByTimeAsync(6000);
    await w2;

    expect(p.attempt).toBe(2);
    expect(p.currentDelaySeconds).toBe(12);

    p.reset();
    expect(p.attempt).toBe(0);
    expect(p.currentDelaySeconds).toBe(3.0);
  });

  it("커스텀 파라미터 (initial 1, max 10, multiplier 3)", async () => {
    const p = new ReconnectPolicy(1.0, 10.0, 3.0);
    const expectedSequence = [1, 3, 9, 10, 10];

    for (let i = 0; i < expectedSequence.length; i++) {
      expect(p.currentDelaySeconds).toBe(expectedSequence[i]!);
      const promise = p.wait();
      await vi.advanceTimersByTimeAsync(expectedSequence[i]! * 1000);
      await promise;
    }
  });
});
