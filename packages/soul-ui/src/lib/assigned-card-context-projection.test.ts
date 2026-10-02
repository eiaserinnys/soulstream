import { describe, expect, it } from "vitest";

import { placeAssignedCardContextsAtInputAnchors } from "./assigned-card-context-projection";
import { formatAssignedCardContextSnapshot } from "./assigned-card-context-content";
import { formatBoardWorkspaceTime } from "../board-workspace/board-workspace-items";

interface Item {
  treeNodeId: string;
  treeNodeType: string;
  eventId?: number;
  inputId?: string;
  preparedInputId?: string;
}

const input = (id: number, inputId: string, type = "intervention"): Item => ({
  treeNodeId: `input-${id}`, treeNodeType: type, eventId: id, inputId,
});
const snapshot = (id: number, inputId?: string): Item => ({
  treeNodeId: `snapshot-${id}`, treeNodeType: "assigned_card_context", eventId: id,
  preparedInputId: inputId,
});
const ids = (items: Item[]) => items.map(item => item.treeNodeId);

describe("placeAssignedCardContextsAtInputAnchors", () => {
  it("projects new and legacy raw snapshots without showing stored verbose content", () => {
    const fresh = formatAssignedCardContextSnapshot({capturedAt:"2026-10-02T01:00:00Z",total:2,omitted:0,cards:[
      {id:"a",title:"첫 카드",status:"running",latestCommentAt:"2026-10-02T00:30:00Z",latestReportAt:"2026-10-02T00:20:00Z"},
      {id:"b",title:"둘째 카드",status:"review",latestCommentAt:null,latestReportAt:null},
    ]});
    expect(fresh).toBe(`첫 카드 · 실행 중 · 마지막 보고 ${formatBoardWorkspaceTime("2026-10-02T00:20:00Z")} · 최근 커멘트 이후 보고 없음\n둘째 카드 · 검수 대기 · 보고 없음`);
    const legacy = formatAssignedCardContextSnapshot({capturedAt:"2026-10-02T01:00:00Z",total:1,omitted:0,cards:[
      {id:"old",title:"과거 카드",status:"queued",version:7,instruction:"긴 지시",report:"긴 보고"},
    ]});
    expect(legacy).toBe("과거 카드 · 대기 · 마지막 보고 시각 확인 불가");
  });

  it("moves a late prepared snapshot directly below its exact initial or intervention input", () => {
    expect(ids(placeAssignedCardContextsAtInputAnchors([
      input(10, "initial", "user_message"),
      { treeNodeId: "answer-11", treeNodeType: "assistant_message", eventId: 11 },
      snapshot(20, "initial"),
      input(30, "active"),
      { treeNodeId: "answer-31", treeNodeType: "assistant_message", eventId: 31 },
      snapshot(40, "active"),
    ]))).toEqual(["input-10", "snapshot-20", "answer-11", "input-30", "snapshot-40", "answer-31"]);
  });

  it("keeps only the latest duplicate and hides null or unloaded identities until reload supplies the anchor", () => {
    const events = [input(10, "queued"), snapshot(20, "queued"), snapshot(21, "queued"), snapshot(22), snapshot(23, "missing")];
    expect(ids(placeAssignedCardContextsAtInputAnchors(events))).toEqual(["input-10", "snapshot-21"]);
    expect(ids(placeAssignedCardContextsAtInputAnchors([input(5, "missing"), ...events]))).toEqual([
      "input-5", "snapshot-23", "input-10", "snapshot-21",
    ]);
  });
});
