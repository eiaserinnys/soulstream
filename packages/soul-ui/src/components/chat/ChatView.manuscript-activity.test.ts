import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { groupManuscriptMessages } from "../../lib/grouping";

function message(
  id: string,
  role: ChatMessage["role"],
  treeNodeType: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: id,
    treeNodeId: id,
    treeNodeType,
    ...extra,
  } as ChatMessage;
}

describe("manuscript activity projection", () => {
  it("folds a contiguous tool and thinking run into one activity row", () => {
    const projected = groupManuscriptMessages([
      message("tool-a", "tool", "tool"),
      message("thinking-a", "assistant", "thinking"),
      message("tool-b", "tool", "tool"),
      message("reply", "assistant", "text"),
    ]);

    expect(projected).toEqual([
      { type: "activity-group", messages: [
        expect.objectContaining({ id: "tool-a" }),
        expect.objectContaining({ id: "thinking-a" }),
        expect.objectContaining({ id: "tool-b" }),
      ] },
      { type: "single", msg: expect.objectContaining({ id: "reply" }) },
    ]);
  });

  it("folds one tool call and leaves a thinking-only run as prose rows", () => {
    const projected = groupManuscriptMessages([
      message("tool", "tool", "tool"),
      message("reply", "assistant", "text"),
      message("thinking-a", "assistant", "thinking"),
      message("thinking-b", "assistant", "thinking"),
    ]);

    expect(projected[0]).toEqual({
      type: "activity-group",
      messages: [expect.objectContaining({ id: "tool" })],
    });
    expect(projected.slice(1)).toEqual([
      { type: "single", msg: expect.objectContaining({ id: "reply" }) },
      { type: "single", msg: expect.objectContaining({ id: "thinking-a" }) },
      { type: "single", msg: expect.objectContaining({ id: "thinking-b" }) },
    ]);
  });

  it("ends activity at visible rows and keeps turn summaries attached to the preceding row", () => {
    const activity = message("tool", "tool", "tool");
    const summary = message("summary", "system", "turn_summary");
    const projected = groupManuscriptMessages([
      activity,
      message("system", "system", "notification"),
      message("thinking", "assistant", "thinking"),
      summary,
    ]);

    expect(projected).toEqual([
      { type: "activity-group", messages: [activity] },
      { type: "single", msg: expect.objectContaining({ id: "system" }) },
      {
        type: "summary-group",
        anchor: { type: "single", msg: expect.objectContaining({ id: "thinking" }) },
        summaries: [summary],
      },
    ]);
  });
});
