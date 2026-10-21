import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./flatten-tree";
import { projectPersistentWorkDetails } from "./persistent-work-details-projection";

function makeMessage(
  id: string,
  treeNodeType: string,
  extra: Record<string, unknown> = {},
): ChatMessage {
  return {
    id,
    role: treeNodeType === "user_message" ? "user" : "system",
    content: "",
    treeNodeId: id,
    treeNodeType,
    ...extra,
  } as ChatMessage;
}

describe("projectPersistentWorkDetails", () => {
  it("drops detached turn summaries, complete captions, and user context when hidden", () => {
    const summary = makeMessage("summary-1", "turn_summary", { content: "요약" });
    const complete = makeMessage("complete-2", "complete", {
      turnSummaryCaption: { treeNodeId: "summary-1", content: "요약" },
    });
    const user = makeMessage("user-3", "user_message", {
      contextItems: [{ key: "card", label: "담당 카드", content: "내용" }],
    });

    const result = projectPersistentWorkDetails([summary, complete, user], false);

    expect(result.map((message) => message.id)).toEqual(["complete-2", "user-3"]);
    expect(result[0]!.turnSummaryCaption).toBeUndefined();
    expect(result[1]!.contextItems).toBeUndefined();
  });

  it("leaves unrelated messages untouched when hidden", () => {
    const assistant = makeMessage("assistant-1", "assistant_message", { content: "응답" });
    const tool = makeMessage("tool-2", "tool", { content: "Read" });
    const intervention = makeMessage("intervention-3", "intervention", {
      contextItems: [{ key: "report", label: "보고", content: "내용" }],
    });

    const result = projectPersistentWorkDetails([assistant, tool, intervention], false);

    expect(result).toEqual([assistant, tool, intervention]);
    expect(result[0]).toBe(assistant);
    expect(result[2]!.contextItems).toEqual([{ key: "report", label: "보고", content: "내용" }]);
  });

  it("returns the same messages unchanged when shown", () => {
    const summary = makeMessage("summary-1", "turn_summary", { content: "요약" });
    const complete = makeMessage("complete-2", "complete", {
      turnSummaryCaption: { treeNodeId: "summary-1", content: "요약" },
    });
    const user = makeMessage("user-3", "user_message", {
      contextItems: [{ key: "card", label: "담당 카드", content: "내용" }],
    });
    const messages = [summary, complete, user];

    expect(projectPersistentWorkDetails(messages, true)).toBe(messages);
  });
});
