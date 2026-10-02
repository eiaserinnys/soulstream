import { describe, expect, it } from "vitest";

import { placeAssignedCardContextsAtInputAnchors } from "./assigned-card-context-projection";

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
