import { afterEach, describe, expect, it } from "vitest";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import {
  clearFolderStarChange,
  applyStarredFolderChanges,
  getFolderStarChanges,
  publishFolderStarChange,
  resetFolderStarChangesForTest,
  folderStarredState,
  type FolderStarChange,
} from "./task-star-store";

describe("task star projection", () => {
  afterEach(() => resetFolderStarChangesForTest());

  it("removes cleared tasks and adds newly starred tasks immediately", () => {
    const first = page("task-1", true);
    const second = page("task-2", true);
    const third = page("task-3", true);
    const changes: FolderStarChange[] = [
      { page: first, starred: false },
      { page: third, starred: true },
    ];

    expect(applyStarredFolderChanges([first, second], changes)).toEqual([second, third]);
    expect(folderStarredState(first.id, changes, true)).toBe(false);
    expect(folderStarredState(third.id, changes, false)).toBe(true);
  });

  it("drops the optimistic overlay when its request settles so newer server data wins", () => {
    const oldPage = page("task-1", true);
    const mutationId = publishFolderStarChange({
      page: { ...oldPage, metadata: { ...oldPage.metadata, starred: false } },
      starred: false,
    });

    expect(applyStarredFolderChanges([oldPage], getFolderStarChanges())).toEqual([]);

    const serverPage = { ...oldPage, title: "Renamed on the server", version: 3 };
    clearFolderStarChange(oldPage.id, mutationId);

    expect(getFolderStarChanges()).toEqual([]);
    expect(applyStarredFolderChanges([serverPage], getFolderStarChanges())).toEqual([serverPage]);
  });

  it("keeps a newer page mutation when an older request settles last", () => {
    const first = publishFolderStarChange({ page: page("task-1", false), starred: false });
    const secondPage = { ...page("task-1", true), title: "latest" };
    publishFolderStarChange({ page: secondPage, starred: true });

    clearFolderStarChange("task-1", first);

    expect(getFolderStarChanges()).toEqual([{ page: secondPage, starred: true }]);
  });
});

function page(id: string, starred: boolean): PageDto {
  return {
    id,
    title: id,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: { starred },
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}
