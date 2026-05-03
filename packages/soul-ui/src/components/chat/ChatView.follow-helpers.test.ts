/**
 * ChatView.follow-helpers — decideFollowOnAtBottomChange 단위 테스트
 *
 * 검증 매트릭스:
 *   atBottom × (sessionMs < settle | sessionMs >= settle) × prependAgeMs
 *
 * 시그니처:
 *   decideFollowOnAtBottomChange(
 *     reportedAtBottom,
 *     sessionMs,
 *     prependAgeMs?,        // 3번째 위치 (신규)
 *     settleThresholdMs?,   // 4번째 위치
 *     prependSettleMs?,     // 5번째 위치
 *   )
 */

import { describe, it, expect } from "vitest";
import {
  decideFollowOnAtBottomChange,
  SESSION_SETTLE_THRESHOLD_MS,
  PREPEND_SETTLE_THRESHOLD_MS,
} from "./ChatView.follow-helpers";

describe("decideFollowOnAtBottomChange — session settle 가드 (false 보고)", () => {
  it("atBottom=false 이고 sessionMs < settle → null (measure 깜빡임 무시)", () => {
    expect(decideFollowOnAtBottomChange(false, 100, null, 300)).toBeNull();
    expect(decideFollowOnAtBottomChange(false, 0, null, 300)).toBeNull();
    expect(decideFollowOnAtBottomChange(false, 299, null, 300)).toBeNull();
  });

  it("atBottom=false 이고 sessionMs >= settle → false (사용자 스크롤 인식)", () => {
    expect(decideFollowOnAtBottomChange(false, 300, null, 300)).toBe(false);
    expect(decideFollowOnAtBottomChange(false, 500, null, 300)).toBe(false);
    expect(decideFollowOnAtBottomChange(false, 5000, null, 300)).toBe(false);
  });

  it("기본 임계값(SESSION_SETTLE_THRESHOLD_MS)은 300ms", () => {
    expect(SESSION_SETTLE_THRESHOLD_MS).toBe(300);
    // 인자 미전달 시 동일 동작
    expect(decideFollowOnAtBottomChange(false, 100)).toBeNull();
    expect(decideFollowOnAtBottomChange(false, 400)).toBe(false);
  });

  it("커스텀 settle 임계값(4번째 위치)을 지정할 수 있다", () => {
    // 임계값 100ms로 좁히면 sessionMs=200은 안정화 후로 간주
    expect(decideFollowOnAtBottomChange(false, 200, null, 100)).toBe(false);
    // 임계값 1000ms로 늘리면 sessionMs=500은 아직 안정화 전
    expect(decideFollowOnAtBottomChange(false, 500, null, 1000)).toBeNull();
  });
});

describe("decideFollowOnAtBottomChange — atBottom=true 단순 케이스", () => {
  it("atBottom=true 이고 prependAgeMs=null → 항상 true (기존 동작 보존)", () => {
    expect(decideFollowOnAtBottomChange(true, 0, null)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 100, null)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 300, null)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 99999, null)).toBe(true);
  });

  it("3번째 인자 미전달 시(undefined) prependAgeMs=null과 동일하게 true 신뢰", () => {
    expect(decideFollowOnAtBottomChange(true, 0)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 1000)).toBe(true);
  });
});

describe("decideFollowOnAtBottomChange — prepend settle 가드 (true 보고, 신규)", () => {
  it("atBottom=true + prependAgeMs < prependSettle → null (firstItemIndex 재계산 깜빡임 무시)", () => {
    expect(decideFollowOnAtBottomChange(true, 5000, 0)).toBeNull();
    expect(decideFollowOnAtBottomChange(true, 5000, 200)).toBeNull();
    expect(decideFollowOnAtBottomChange(true, 5000, 499)).toBeNull();
  });

  it("atBottom=true + prependAgeMs >= prependSettle → true (안정화 후 신뢰)", () => {
    expect(decideFollowOnAtBottomChange(true, 5000, 500)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 5000, 1000)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 5000, 99999)).toBe(true);
  });

  it("기본 prepend 임계값(PREPEND_SETTLE_THRESHOLD_MS)은 500ms", () => {
    expect(PREPEND_SETTLE_THRESHOLD_MS).toBe(500);
  });

  it("커스텀 prepend 임계값(5번째 위치)을 지정할 수 있다", () => {
    // 임계값 1000ms로 늘리면 prependAgeMs=600은 아직 안정화 전
    expect(decideFollowOnAtBottomChange(true, 5000, 600, 300, 1000)).toBeNull();
    // 임계값 100ms로 좁히면 prependAgeMs=200은 안정화 후
    expect(decideFollowOnAtBottomChange(true, 5000, 200, 300, 100)).toBe(true);
  });

  it("session settle 윈도가 끝나기 전이라도 atBottom=true는 prepend 가드만 검사", () => {
    // sessionMs<300, atBottom=true, prependAgeMs=null → true (기존 동작)
    expect(decideFollowOnAtBottomChange(true, 100, null)).toBe(true);
    // sessionMs<300, atBottom=true, prependAgeMs<500 → null (prepend 가드 발동)
    expect(decideFollowOnAtBottomChange(true, 100, 200)).toBeNull();
  });
});
