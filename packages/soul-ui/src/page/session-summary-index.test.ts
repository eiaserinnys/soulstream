import { describe, expect, it } from "vitest";

import type { SessionSummary } from "../shared/types";
import {
  createSessionSummaryIndex,
  resolveSessionReference,
} from "./session-summary-index";

function session(id: string, status: SessionSummary["status"]): SessionSummary {
  return { agentSessionId: id, status, eventCount: 0, prompt: `Prompt ${id}` };
}

describe("session summary index", () => {
  it("is a derived lookup rebuilt from the canonical session snapshot", () => {
    const running = createSessionSummaryIndex([session("session-a", "running")]);
    const completed = createSessionSummaryIndex([session("session-a", "completed")]);

    expect(resolveSessionReference(running, "session-a")).toMatchObject({
      kind: "ready",
      summary: { status: "running" },
    });
    expect(resolveSessionReference(completed, "session-a")).toMatchObject({
      kind: "ready",
      summary: { status: "completed" },
    });
  });

  it("keeps missing and permission-denied references explicit without inventing a status", () => {
    expect(resolveSessionReference(createSessionSummaryIndex([]), "session-secret")).toEqual({
      kind: "unavailable",
      sessionId: "session-secret",
      message: "Session unavailable — it may have been deleted or you may not have access.",
    });
  });
});
