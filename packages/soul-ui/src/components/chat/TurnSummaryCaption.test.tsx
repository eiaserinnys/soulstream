import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { TurnSummaryCaption } from "./TurnSummaryCaption";

describe("TurnSummaryCaption", () => {
  it("renders the summary as a muted note aligned with assistant content", () => {
    const msg: ChatMessage = {
      id: "summary-30",
      role: "turn_summary",
      content: "요청을 처리하고 결과를 전달했다.",
      treeNodeId: "turn-summary-30",
      treeNodeType: "turn_summary",
      eventId: 30,
      anchorStartEventId: 10,
      anchorFinalResponseEventId: 20,
    };

    const html = renderToStaticMarkup(<TurnSummaryCaption msg={msg} />);

    expect(html).toContain('data-slot="turn-summary-caption"');
    expect(html).toContain('role="note"');
    expect(html).toContain('aria-label="턴 요약"');
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("요청을 처리하고 결과를 전달했다.");
  });
});
