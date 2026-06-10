/**
 * ChatView.reverse-helpers 단위 테스트.
 *
 * Phase 4 재설계 — virtuoso firstItemIndex / focusEventId 매칭을 순수 함수 레벨에서 고정한다.
 */

import { describe, it, expect } from "vitest";
import {
  START_INDEX,
  computeFirstItemIndex,
  getBottomScrollLocation,
  getInitialTopMostItemIndex,
  findFocusIndex,
} from "./ChatView.reverse-helpers";
import type { MessageOrGroup } from "../../lib/grouping";
import type { ChatMessage } from "../../lib/flatten-tree";

const makeMsg = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "msg-x",
  role: "assistant",
  content: "",
  treeNodeId: "node-assistant_message-0",
  treeNodeType: "assistant_message",
  ...overrides,
});

describe("computeFirstItemIndex", () => {
  it("prepend 없을 때 START_INDEX 반환", () => {
    expect(computeFirstItemIndex(0)).toBe(START_INDEX);
  });

  it("prepend 50개면 START_INDEX - 50", () => {
    expect(computeFirstItemIndex(50)).toBe(START_INDEX - 50);
  });

  it("prepend 누적 200개면 START_INDEX - 200", () => {
    expect(computeFirstItemIndex(200)).toBe(START_INDEX - 200);
  });

  it("START_INDEX는 10_000 이상이어야 virtuoso prepend 안전", () => {
    expect(START_INDEX).toBeGreaterThanOrEqual(10_000);
  });
});

describe("bottom focus index helpers", () => {
  it("keeps initialTopMostItemIndex relative to the current data array", () => {
    expect(getInitialTopMostItemIndex(0)).toBe(0);
    expect(getInitialTopMostItemIndex(1)).toEqual({ index: 0, align: "end" });
    expect(getInitialTopMostItemIndex(5)).toEqual({ index: 4, align: "end" });
  });

  it("uses Virtuoso LAST for imperative bottom scrolling", () => {
    expect(getBottomScrollLocation(0)).toBeNull();
    expect(getBottomScrollLocation(1)).toEqual({ index: "LAST", align: "end" });
    expect(getBottomScrollLocation(5)).toEqual({ index: "LAST", align: "end" });
  });
});

describe("findFocusIndex", () => {
  const grouped: MessageOrGroup[] = [
    { type: "single", msg: makeMsg({ id: "a", eventId: 100, treeNodeId: "node-user_message-100" }) },
    {
      type: "tool-group",
      messages: [
        makeMsg({ id: "b1", role: "tool", eventId: 110, treeNodeId: "node-tool_use-110" }),
        makeMsg({ id: "b2", role: "tool", eventId: 111, treeNodeId: "node-tool_result-111" }),
      ],
    },
    { type: "single", msg: makeMsg({ id: "c", eventId: 120, treeNodeId: "node-assistant_message-120" }) },
    // treeNodeId 매칭 전용 — eventId 없음
    { type: "single", msg: makeMsg({ id: "d", treeNodeId: "node-thinking-777" }) },
  ];

  it("focusEventId가 null이면 -1", () => {
    expect(findFocusIndex(grouped, null)).toBe(-1);
  });

  it("매칭되는 single eventId 찾기", () => {
    expect(findFocusIndex(grouped, 100)).toBe(0);
    expect(findFocusIndex(grouped, 120)).toBe(2);
  });

  it("tool-group 내 메시지의 eventId 매칭", () => {
    expect(findFocusIndex(grouped, 110)).toBe(1);
    expect(findFocusIndex(grouped, 111)).toBe(1);
  });

  it("treeNodeId suffix 매칭 (eventId 미지정 케이스)", () => {
    expect(findFocusIndex(grouped, 777)).toBe(3);
  });

  it("매칭 없으면 -1", () => {
    expect(findFocusIndex(grouped, 999)).toBe(-1);
  });

  it("빈 배열에 대해 -1", () => {
    expect(findFocusIndex([], 100)).toBe(-1);
  });
});
