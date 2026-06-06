import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../shared/types";
import { resolveFolderActiveSessionDecision } from "./folder-active-session";

function makeSession(agentSessionId: string): SessionSummary {
  const now = "2026-05-24T00:00:00.000Z";
  return {
    agentSessionId,
    sessionType: "claude",
    status: "running",
    createdAt: now,
    updatedAt: now,
    eventCount: 0,
  };
}

describe("resolveFolderActiveSessionDecision", () => {
  it("selects the first loaded folder session on desktop when nothing is active", () => {
    const first = makeSession("sess-first");
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey: null,
      isMobile: false,
      sessions: [first, makeSession("sess-second")],
    });

    expect(decision).toEqual({ action: "select", session: first });
  });

  it("selects the first folder session when the active session is outside the folder", () => {
    const first = makeSession("sess-folder");
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey: "sess-feed",
      isMobile: false,
      sessions: [first],
    });

    expect(decision).toEqual({ action: "select", session: first });
  });

  it("keeps the active session when it still belongs to the folder", () => {
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey: "sess-current",
      isMobile: false,
      sessions: [makeSession("sess-current"), makeSession("sess-next")],
    });

    expect(decision).toEqual({ action: "none" });
  });

  it("clears stale desktop selection when the folder has no sessions", () => {
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey: "sess-old-folder",
      isMobile: false,
      sessions: [],
    });

    expect(decision).toEqual({ action: "clear" });
  });

  it("keeps a selected folder session while the folder list is still loading", () => {
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey: "sess-from-feed",
      keepActiveSessionWhenEmpty: true,
      isMobile: false,
      sessions: [],
    });

    expect(decision).toEqual({ action: "none" });
  });

  it("does not auto-open or clear chat selection on mobile folder navigation", () => {
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey: "sess-old-folder",
      isMobile: true,
      sessions: [makeSession("sess-folder")],
    });

    expect(decision).toEqual({ action: "none" });
  });
});
