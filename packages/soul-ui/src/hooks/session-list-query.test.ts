import { describe, expect, it } from "vitest";
import { buildFetchSessionsOptions } from "./session-list-query";

describe("buildFetchSessionsOptions", () => {
  it("feed query key never inherits a selected folder filter", () => {
    const result = buildFetchSessionsOptions(
      ["sessions", "all", "feed", "folder-from-stale-store"],
      0,
      50,
    );

    expect(result).toEqual({ offset: 0, limit: 50 });
  });

  it("folder query key uses the folder id captured in the key", () => {
    const result = buildFetchSessionsOptions(
      ["sessions", "all", "folder", "folder-B"],
      50,
      50,
    );

    expect(result).toEqual({ offset: 50, limit: 50, folderId: "folder-B" });
  });

  it("session type filter is derived from the query key", () => {
    const result = buildFetchSessionsOptions(
      ["sessions", "claude", "folder", "folder-A"],
      0,
      25,
    );

    expect(result).toEqual({
      sessionType: "claude",
      offset: 0,
      limit: 25,
      folderId: "folder-A",
    });
  });
});
