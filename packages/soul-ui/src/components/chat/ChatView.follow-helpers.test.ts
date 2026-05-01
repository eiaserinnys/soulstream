/**
 * ChatView.follow-helpers — decideFollowOnAtBottomChange 단위 테스트
 *
 * 검증 매트릭스:
 *   atBottom × (sessionMs < settle | sessionMs >= settle) = 4 케이스
 */

import { describe, it, expect } from "vitest";
import {
  decideFollowOnAtBottomChange,
  SESSION_SETTLE_THRESHOLD_MS,
} from "./ChatView.follow-helpers";

describe("decideFollowOnAtBottomChange", () => {
  it("atBottom=false 이고 sessionMs < settle → null (measure 깜빡임 무시)", () => {
    expect(decideFollowOnAtBottomChange(false, 100, 300)).toBeNull();
    expect(decideFollowOnAtBottomChange(false, 0, 300)).toBeNull();
    expect(decideFollowOnAtBottomChange(false, 299, 300)).toBeNull();
  });

  it("atBottom=false 이고 sessionMs >= settle → false (사용자 스크롤 인식)", () => {
    expect(decideFollowOnAtBottomChange(false, 300, 300)).toBe(false);
    expect(decideFollowOnAtBottomChange(false, 500, 300)).toBe(false);
    expect(decideFollowOnAtBottomChange(false, 5000, 300)).toBe(false);
  });

  it("atBottom=true 이면 sessionMs와 무관하게 true (follow 켬)", () => {
    expect(decideFollowOnAtBottomChange(true, 0, 300)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 100, 300)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 300, 300)).toBe(true);
    expect(decideFollowOnAtBottomChange(true, 99999, 300)).toBe(true);
  });

  it("기본 임계값(SESSION_SETTLE_THRESHOLD_MS)은 300ms", () => {
    expect(SESSION_SETTLE_THRESHOLD_MS).toBe(300);
    // 인자 미전달 시 동일 동작
    expect(decideFollowOnAtBottomChange(false, 100)).toBeNull();
    expect(decideFollowOnAtBottomChange(false, 400)).toBe(false);
  });

  it("커스텀 임계값을 지정할 수 있다", () => {
    // 임계값 100ms로 좁히면 sessionMs=200은 안정화 후로 간주
    expect(decideFollowOnAtBottomChange(false, 200, 100)).toBe(false);
    // 임계값 1000ms로 늘리면 sessionMs=500은 아직 안정화 전
    expect(decideFollowOnAtBottomChange(false, 500, 1000)).toBeNull();
  });
});
