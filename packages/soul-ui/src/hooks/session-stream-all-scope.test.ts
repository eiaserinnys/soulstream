import { describe, expect, it } from "vitest";

import { shouldApplySessionCreatedToCache } from "./session-stream-helpers";

describe("all-scope session stream cache", () => {
  it("accepts every session_created delta regardless of folder or type", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "all", null],
        "llm",
        "hidden-folder",
        {
          folders: [{
            id: "hidden-folder",
            name: "Hidden",
            sortOrder: 0,
            settings: { excludeFromFeed: true },
          }],
          sessions: {},
        },
      ),
    ).toBe(true);
  });
});
