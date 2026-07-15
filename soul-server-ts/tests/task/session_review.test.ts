import { describe, expect, it } from "vitest";

import {
  initialSessionReview,
  isUserInitiatedSession,
  reviewStateAfterFollowup,
  reviewStateAfterTerminal,
} from "../../src/task/session_review.js";

describe("session review policy", () => {
  it.each(["slack", "soul-app"])(
    "marks %s-created sessions as human-owned",
    (source) => {
      expect(initialSessionReview({ source })).toEqual({
        reviewRequired: true,
        reviewState: "not_required",
      });
    },
  );

  it.each([
    { source: "browser", user_id: "user@example.com" },
    { source: "browser", email: "user@example.com" },
    { source: "browser", display_name: "Alice" },
  ])("marks an identified browser caller as user-initiated", (callerInfo) => {
    expect(isUserInitiatedSession(callerInfo)).toBe(true);
    expect(initialSessionReview(callerInfo)).toEqual({
      reviewRequired: true,
      reviewState: "not_required",
    });
  });

  it.each([
    { source: "browser" },
    { source: "browser", user_id: "", email: "  ", display_name: null },
    { source: "browser", ip: "127.0.0.1", user_agent: "automation-client" },
  ])("keeps an anonymous browser caller out of review", (callerInfo) => {
    expect(isUserInitiatedSession(callerInfo)).toBe(false);
    expect(initialSessionReview(callerInfo)).toEqual({
      reviewRequired: false,
      reviewState: "not_required",
    });
  });

  it.each([
    "agent",
    "api",
    "channel_observer",
    "llm",
    "system",
    "execute-proxy",
    undefined,
    null,
  ])(
    "keeps non-human source %s out of review",
    (source) => {
      expect(initialSessionReview(source === undefined ? undefined : { source })).toEqual({
        reviewRequired: false,
        reviewState: "not_required",
      });
    },
  );

  it("moves human-owned terminal results to needs_review", () => {
    expect(reviewStateAfterTerminal(true)).toBe("needs_review");
  });

  it("auto-acknowledges non-user terminal results", () => {
    expect(reviewStateAfterTerminal(false)).toBe("acknowledged");
  });

  it("auto-acknowledges only a pending previous result on follow-up", () => {
    expect(reviewStateAfterFollowup("needs_review")).toBe("acknowledged");
    expect(reviewStateAfterFollowup("acknowledged")).toBe("acknowledged");
    expect(reviewStateAfterFollowup("not_required")).toBe("not_required");
  });
});
