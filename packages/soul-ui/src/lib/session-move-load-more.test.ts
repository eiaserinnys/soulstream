import { describe, expect, it } from "vitest";
import type { CatalogState } from "../shared/types";
import { shouldLoadMoreAfterSessionMove } from "./session-move-load-more";

const CATALOG: CatalogState = {
  folders: [
    { id: "visible-folder", name: "Visible", sortOrder: 0 },
    {
      id: "hidden-folder",
      name: "Hidden",
      sortOrder: 1,
      settings: { excludeFromFeed: true },
    },
  ],
  sessions: {
    "in-visible-folder": { folderId: "visible-folder", displayName: null },
    "in-hidden-folder": { folderId: "hidden-folder", displayName: null },
    "unassigned": { folderId: null, displayName: null },
  },
};

describe("shouldLoadMoreAfterSessionMove", () => {
  it("keeps feed pagination idle when the moved session remains feed-visible", () => {
    expect(
      shouldLoadMoreAfterSessionMove({
        viewMode: "feed",
        selectedFolderId: "visible-folder",
        catalog: CATALOG,
        sessionIds: ["unassigned"],
        targetFolderId: "visible-folder",
      }),
    ).toBe(false);
  });

  it("requests feed backfill when a visible session moves into an excluded folder", () => {
    expect(
      shouldLoadMoreAfterSessionMove({
        viewMode: "feed",
        selectedFolderId: "visible-folder",
        catalog: CATALOG,
        sessionIds: ["in-visible-folder"],
        targetFolderId: "hidden-folder",
      }),
    ).toBe(true);
  });

  it("does not backfill feed for sessions that were already hidden from feed", () => {
    expect(
      shouldLoadMoreAfterSessionMove({
        viewMode: "feed",
        selectedFolderId: "visible-folder",
        catalog: CATALOG,
        sessionIds: ["in-hidden-folder"],
        targetFolderId: "visible-folder",
      }),
    ).toBe(false);
  });

  it("requests folder backfill when a visible row leaves the selected folder", () => {
    expect(
      shouldLoadMoreAfterSessionMove({
        viewMode: "folder",
        selectedFolderId: "visible-folder",
        catalog: CATALOG,
        sessionIds: ["in-visible-folder"],
        targetFolderId: "hidden-folder",
      }),
    ).toBe(true);
  });

  it("keeps folder pagination idle for same-folder moves", () => {
    expect(
      shouldLoadMoreAfterSessionMove({
        viewMode: "folder",
        selectedFolderId: "visible-folder",
        catalog: CATALOG,
        sessionIds: ["in-visible-folder"],
        targetFolderId: "visible-folder",
      }),
    ).toBe(false);
  });

  it("does not backfill a selected folder for sessions that were not in it", () => {
    expect(
      shouldLoadMoreAfterSessionMove({
        viewMode: "folder",
        selectedFolderId: "visible-folder",
        catalog: CATALOG,
        sessionIds: ["unassigned"],
        targetFolderId: "hidden-folder",
      }),
    ).toBe(false);
  });
});
