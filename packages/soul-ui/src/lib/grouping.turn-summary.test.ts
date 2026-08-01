import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./flatten-tree";
import { groupMessages } from "./grouping";

const message = (treeNodeId: string, treeNodeType: string): ChatMessage => ({
  id: treeNodeId,
  role: treeNodeType === "turn_summary" ? "system" : "assistant",
  content: treeNodeId,
  treeNodeId,
  treeNodeType,
});

describe("groupMessages turn summary coordinates", () => {
  it("anchor와 뒤따르는 summary를 stable virtual row 하나로 결합한다", () => {
    const anchor = message("asst-msg-100", "assistant_message");
    const summary = message("turn-summary-110", "turn_summary");
    const complete = message("complete-120", "complete");

    expect(groupMessages([anchor, summary, complete])).toEqual([
      { type: "summary-group", anchor: { type: "single", msg: anchor }, summaries: [summary] },
      { type: "single", msg: complete },
    ]);
  });

  it("같은 위치의 복수 summary를 같은 virtual row 안에서 순서대로 보존한다", () => {
    const anchor = message("asst-msg-100", "assistant_message");
    const first = message("turn-summary-110", "turn_summary");
    const second = message("turn-summary-111", "turn_summary");

    expect(groupMessages([anchor, first, second])).toEqual([
      {
        type: "summary-group",
        anchor: { type: "single", msg: anchor },
        summaries: [first, second],
      },
    ]);
  });

  it("선행 render row가 없는 legacy summary는 독립 행으로 fail-open한다", () => {
    const summary = message("turn-summary-10", "turn_summary");

    expect(groupMessages([summary])).toEqual([{ type: "single", msg: summary }]);
  });
});
