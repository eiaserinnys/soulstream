import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./flatten-tree";
import { placeTurnSummaries } from "./turn-summary-placement";

function message(
  id: string,
  role: ChatMessage["role"],
  eventId: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: id,
    treeNodeId: id,
    treeNodeType: role,
    eventId,
    ...extra,
  };
}

describe("placeTurnSummaries", () => {
  it("places a late summary immediately after its final response anchor", () => {
    const user = message("user", "user", 10);
    const assistant = message("assistant", "assistant", 20);
    const completion = message("complete", "system", 21);
    const newerTurn = message("newer-user", "user", 25);
    const summary = message("summary", "turn_summary", 30, {
      anchorStartEventId: 10,
      anchorFinalResponseEventId: 20,
    });

    const placed = placeTurnSummaries([
      user,
      assistant,
      completion,
      newerTurn,
      summary,
    ]);

    expect(placed).toEqual([
      user,
      assistant,
      summary,
      completion,
      newerTurn,
    ]);
    expect(placed[1]).toBe(assistant);
    expect(placed[2]).toBe(summary);
  });

  it("hides an unanchored summary until history prepend supplies the anchor", () => {
    const summary = message("summary", "turn_summary", 30, {
      anchorStartEventId: 10,
      anchorFinalResponseEventId: 20,
    });
    const current = message("current", "user", 25);

    expect(placeTurnSummaries([current, summary])).toEqual([current]);

    const anchor = message("assistant", "assistant", 20);
    expect(placeTurnSummaries([anchor, current, summary])).toEqual([
      anchor,
      summary,
      current,
    ]);
  });

  it("returns the original array when no summaries are present", () => {
    const messages = [message("assistant", "assistant", 20)];
    expect(placeTurnSummaries(messages)).toBe(messages);
  });
});
