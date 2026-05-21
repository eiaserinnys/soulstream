import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { resolveActiveSessionSummary } from "./active-session-summary";

function session(
  agentSessionId: string,
  nodeId: string | undefined,
): SessionSummary {
  return {
    agentSessionId,
    nodeId,
    status: "running",
    eventCount: 0,
  };
}

describe("resolveActiveSessionSummary", () => {
  it("uses the active summary when the active session is not in the visible folder list", () => {
    const active = session("session-a", "node-a");
    const visibleSessions = [session("session-b", "node-b")];

    expect(
      resolveActiveSessionSummary("session-a", active, visibleSessions),
    ).toBe(active);
  });

  it("ignores a stale active summary and falls back to visible sessions", () => {
    const active = session("session-a", "node-a");
    const visible = session("session-b", "node-b");

    expect(
      resolveActiveSessionSummary("session-b", active, [visible]),
    ).toBe(visible);
  });

  it("returns undefined when no session is active", () => {
    expect(
      resolveActiveSessionSummary(null, session("session-a", "node-a"), []),
    ).toBeUndefined();
  });
});
