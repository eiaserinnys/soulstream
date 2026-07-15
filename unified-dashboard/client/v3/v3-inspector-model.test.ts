import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import { openDocumentInV3, openSessionInV3 } from "./v3-inspector-model";

describe("v3 inspector activation", () => {
  it("opens a review session through the v3 chat activation path", () => {
    const calls: string[] = [];
    const session = reviewSession("review-a");

    openSessionInV3(session, {
      setActiveSessionSummary: (value) => calls.push(`summary:${value.agentSessionId}`),
      setActiveSession: (value) => calls.push(`session:${value}`),
      setActiveTab: (value) => calls.push(`tab:${value}`),
      setInspectorOpen: (value) => calls.push(`inspector:${value}`),
    });

    expect(calls).toEqual([
      "summary:review-a",
      "session:review-a",
      "tab:chat",
      "inspector:true",
    ]);
  });

  it("opens a page document in the v3 document inspector", () => {
    const setActiveBoardDocument = vi.fn();
    const setInspectorOpen = vi.fn();

    openDocumentInV3("doc-a", { setActiveBoardDocument, setInspectorOpen });

    expect(setActiveBoardDocument).toHaveBeenCalledWith("doc-a");
    expect(setInspectorOpen).toHaveBeenCalledWith(true);
  });
});

function reviewSession(agentSessionId: string): SessionSummary {
  return {
    agentSessionId,
    status: "completed",
    reviewRequired: true,
    reviewState: "needs_review",
    eventCount: 1,
  };
}
