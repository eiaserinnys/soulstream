import { describe, expect, it } from "vitest";

import {
  buildSessionSearchUrl,
  compactSearchQuery,
  normalizeSearchQuery,
  parseSessionSearchIntent,
  removeSessionSearchIntent,
} from "./index.js";

describe("shared session search contract", () => {
  it("normalizes Unicode, punctuation, and spacing for candidate lookup", () => {
    expect(normalizeSearchQuery("  피드—검색!  ")).toBe("피드 검색");
    expect(compactSearchQuery("피드 검색")).toBe("피드검색");
  });

  it("builds an optional event anchor without inventing one", () => {
    expect(buildSessionSearchUrl({ sessionId: "session-a" }))
      .toBe("/?session=session-a");
    expect(buildSessionSearchUrl({ sessionId: "session a", eventId: "17" }))
      .toBe("/?session=session+a&event=17");
    expect(parseSessionSearchIntent("https://example.test/?session=session-a&event=17"))
      .toEqual({ sessionId: "session-a", eventId: "17" });
  });

  it("parses a legacy feed intent without restoring its retired UI", () => {
    expect(parseSessionSearchIntent("https://example.test/v1#/feed/session-a?event=9"))
      .toEqual({ sessionId: "session-a", eventId: "9" });
    expect(parseSessionSearchIntent("https://example.test/"))
      .toBeNull();
  });

  it("removes only session intent while preserving the relative return location", () => {
    expect(removeSessionSearchIntent("/planner?tab=today&session=session-a&event=4#focus"))
      .toBe("/planner?tab=today#focus");
    expect(removeSessionSearchIntent("/planner?tab=today&event=4#focus"))
      .toBe("/planner?tab=today&event=4#focus");
  });
});
