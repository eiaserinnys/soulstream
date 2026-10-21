import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { groupManuscriptMessages } from "../../lib/grouping";
import { isManuscriptNarration, manuscriptActivityNarrationIds } from "./ChatManuscriptList";
import type { ChatTimelineItem } from "./ChatView.thinking-indicator";

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

  it("dims assistant prose only when the next chronological row is tool activity or thinking", () => {
    const narration = message("narration", "assistant", "text");
    const persistedNarration = message("persisted-narration", "assistant", "assistant_message");
    const tool = message("tool", "tool", "tool");
    const thinking = message("thinking", "assistant", "thinking");
    const final = message("final", "assistant", "text");
    const asSingle = (msg: ChatMessage): Extract<ChatTimelineItem, { type: "single" }> => ({ type: "single", msg });

    expect(isManuscriptNarration(asSingle(narration), asSingle(tool))).toBe(true);
    expect(isManuscriptNarration(asSingle(narration), {
      type: "activity-group",
      messages: [tool],
    })).toBe(true);
    expect(isManuscriptNarration(asSingle(persistedNarration), {
      type: "activity-group",
      messages: [tool],
    })).toBe(true);
    expect(isManuscriptNarration(asSingle(narration), asSingle(thinking))).toBe(true);
    expect(isManuscriptNarration(asSingle(final), undefined)).toBe(false);
  });

  it("keeps an answer dimmed after the activity row is filtered out", () => {
    const projected = groupManuscriptMessages([
      message("narration", "assistant", "text"),
      message("tool", "tool", "tool"),
      message("final", "assistant", "text"),
    ]);
    const narrationIds = manuscriptActivityNarrationIds(projected);
    const visible = projected.filter((item) => item.type !== "activity-group");
    const dimmed = (item: (typeof visible)[number] | undefined) => item?.type === "single"
      && narrationIds.has(item.msg.treeNodeId);

    expect([...narrationIds]).toEqual(["narration"]);
    expect(dimmed(visible[0])).toBe(true);
    expect(dimmed(visible[1])).toBe(false);
  });

  it("unwraps summary anchors and leaves incomplete or non-prose rows unchanged", () => {
    const narration = message("narration", "assistant", "text");
    const tool = message("tool", "tool", "tool");
    const assistantWithUi = message("ui", "assistant", "text", { ui: { version: 1 } as never });
    const assistantThinking = message("thinking", "assistant", "thinking");
    const asSingle = (msg: ChatMessage): Extract<ChatTimelineItem, { type: "single" }> => ({ type: "single", msg });
    const summaryGroup: ChatTimelineItem = {
      type: "summary-group",
      anchor: asSingle(tool),
      summaries: [],
    };

    expect(isManuscriptNarration({
      type: "summary-group",
      anchor: asSingle(narration),
      summaries: [],
    }, summaryGroup)).toBe(true);
    expect(isManuscriptNarration(asSingle(narration), undefined)).toBe(false);
    expect(isManuscriptNarration(asSingle(narration), { type: "thinking-indicator" })).toBe(false);
    expect(isManuscriptNarration(asSingle(narration), {
      type: "pending-message",
      pending: {} as never,
    })).toBe(false);
    expect(isManuscriptNarration(asSingle(narration), asSingle(message("complete", "system", "complete")))).toBe(false);
    expect(isManuscriptNarration(asSingle(assistantWithUi), asSingle(tool))).toBe(false);
    expect(isManuscriptNarration(asSingle(assistantThinking), asSingle(tool))).toBe(false);
  });
});
