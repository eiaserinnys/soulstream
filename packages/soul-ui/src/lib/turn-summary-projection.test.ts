import { describe, expect, it } from "vitest";

import { placeTurnSummariesAtResponseAnchors } from "./turn-summary-projection";

interface Item {
  treeNodeId: string;
  treeNodeType: string;
  eventId?: number;
  summaryFinalResponseEventId?: number;
  summaryParentEventId?: number;
}

const row = (eventId: number): Item => ({
  treeNodeId: `row-${eventId}`,
  treeNodeType: "assistant_message",
  eventId,
});

const summary = (
  eventId: number,
  finalId?: number,
  parentId?: number,
): Item => ({
  treeNodeId: `turn-summary-${eventId}`,
  treeNodeType: "turn_summary",
  eventId,
  summaryFinalResponseEventId: finalId,
  summaryParentEventId: parentId,
});

const keys = (items: Item[]) => items.map((item) => item.treeNodeId);

describe("placeTurnSummariesAtResponseAnchors", () => {
  it("같은 anchor의 요약을 durable ID 순서로 결합하고 stable key 중복을 제거한다", () => {
    const duplicate = summary(140, 100, 100);
    expect(keys(placeTurnSummariesAtResponseAnchors([
      row(100),
      summary(141, 100, 100),
      duplicate,
      duplicate,
      row(150),
    ]))).toEqual([
      "row-100",
      "turn-summary-140",
      "turn-summary-141",
      "row-150",
    ]);
  });

  it("final을 우선하고, final이 미로딩일 때만 로딩된 parent로 fallback한다", () => {
    expect(keys(placeTurnSummariesAtResponseAnchors([
      row(90),
      row(100),
      summary(140, 100, 90),
      summary(141, 999, 90),
    ]))).toEqual([
      "row-90",
      "turn-summary-141",
      "row-100",
      "turn-summary-140",
    ]);
  });

  it("유효하지만 미로딩 anchor는 숨기고 유효 anchor가 전혀 없을 때만 fail-open한다", () => {
    expect(keys(placeTurnSummariesAtResponseAnchors([
      row(100),
      summary(110, Number.MAX_SAFE_INTEGER + 1),
      summary(120, 999),
      row(130),
    ]))).toEqual([
      "row-100",
      "turn-summary-110",
      "row-130",
    ]);
  });
});
