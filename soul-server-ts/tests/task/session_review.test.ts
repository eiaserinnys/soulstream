import { describe, expect, it } from "vitest";

import {
  initialSessionReview,
  reviewStateAfterFollowup,
  reviewStateAfterTerminal,
} from "../../src/task/session_review.js";

describe("session review policy", () => {
  it.each(["slack", "browser", "soul-app"])(
    "marks %s-created sessions as human-owned",
    (source) => {
      expect(initialSessionReview({ source })).toEqual({
        reviewRequired: true,
        reviewState: "not_required",
      });
    },
  );

  it.each(["agent", "api", "llm", "system", "execute-proxy", undefined, null])(
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
    expect(reviewStateAfterTerminal(false)).toBe("not_required");
  });

  it("auto-acknowledges only a pending previous result on follow-up", () => {
    expect(reviewStateAfterFollowup("needs_review")).toBe("acknowledged");
    expect(reviewStateAfterFollowup("acknowledged")).toBe("acknowledged");
    expect(reviewStateAfterFollowup("not_required")).toBe("not_required");
  });
});
