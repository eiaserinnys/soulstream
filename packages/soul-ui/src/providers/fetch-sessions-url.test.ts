import { describe, expect, it } from "vitest";
import { buildFetchSessionsUrl } from "./fetch-sessions-url";

describe("buildFetchSessionsUrl", () => {
  it("returns the base path when no options are provided", () => {
    expect(buildFetchSessionsUrl("/api/sessions")).toBe("/api/sessions");
  });

  it("serializes the existing session list filter contract", () => {
    expect(
      buildFetchSessionsUrl("/api/catalog", {
        sessionType: "claude",
        offset: 50,
        limit: 25,
        folderId: "folder A/B",
        feedOnly: true,
      }),
    ).toBe(
      "/api/catalog?session_type=claude&offset=50&limit=25&folder_id=folder+A%2FB&feed_only=true",
    );
  });

  it("keeps offset zero out of the query while preserving explicit limit zero", () => {
    expect(
      buildFetchSessionsUrl("/api/sessions", {
        offset: 0,
        limit: 0,
      }),
    ).toBe("/api/sessions?limit=0");
  });
});
