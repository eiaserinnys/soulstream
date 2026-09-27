/**
 * ChatView follow behavior unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  resolveFollowOutput,
  shouldScrollToBottomOnTreeChange,
} from "./ChatView.follow-helpers";

describe("resolveFollowOutput — Follow 버튼 의도 정본", () => {
  it("Follow가 켜져 있으면 Virtuoso에 끝 정렬을 요청한다", () => {
    expect(resolveFollowOutput(true)).toBe("auto");
  });

  it("Follow가 꺼져 있으면 Virtuoso 자동 끝 정렬을 비활성화한다", () => {
    expect(resolveFollowOutput(false)).toBe(false);
  });
});

describe("shouldScrollToBottomOnTreeChange — streaming height growth follow", () => {
  it("Follow가 켜져 있고 항목이 있으면 treeVersion 변경에서도 하단 유지가 필요하다", () => {
    expect(shouldScrollToBottomOnTreeChange(true, 1)).toBe(true);
    expect(shouldScrollToBottomOnTreeChange(true, 10)).toBe(true);
  });

  it("Follow가 꺼져 있거나 항목이 없으면 강제 스크롤하지 않는다", () => {
    expect(shouldScrollToBottomOnTreeChange(false, 10)).toBe(false);
    expect(shouldScrollToBottomOnTreeChange(true, 0)).toBe(false);
  });
});
