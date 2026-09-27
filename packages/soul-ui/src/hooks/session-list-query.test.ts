import { describe, expect, it } from "vitest";
import { buildFetchSessionsOptions } from "./session-list-query";

describe("buildFetchSessionsOptions", () => {
  it("feed query key never inherits a selected folder filter", () => {
    const result = buildFetchSessionsOptions(
      ["sessions", "feed", "folder-from-stale-store"],
      0,
      50,
    );

    expect(result).toEqual({ offset: 0, limit: 50, feedOnly: true });
  });

  it("folder query key uses the folder id captured in the key", () => {
    const result = buildFetchSessionsOptions(
      ["sessions", "folder", "folder-B"],
      50,
      50,
    );

    expect(result).toEqual({ offset: 50, limit: 50, folderId: "folder-B" });
  });

  it("all scope requests the unbounded canonical session snapshot", () => {
    const result = buildFetchSessionsOptions(
      ["sessions", "all", null],
      0,
      0,
    );

    expect(result).toEqual({ offset: 0, limit: 0 });
  });
});
