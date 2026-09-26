import { afterEach, describe, expect, it } from "vitest";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import {
  clearTaskStarChange,
  applyStarredTaskChanges,
  getTaskStarChanges,
  publishTaskStarChange,
  resetTaskStarChangesForTest,
  taskStarredState,
  type TaskStarChange,
} from "./task-star-store";

describe("task star projection", () => {
  afterEach(() => resetTaskStarChangesForTest());

  it("removes cleared tasks and adds newly starred tasks immediately", () => {
    const first = page("task-1", true);
    const second = page("task-2", true);
    const third = page("task-3", true);
    const changes: TaskStarChange[] = [
      { page: first, starred: false },
      { page: third, starred: true },
    ];

    expect(applyStarredTaskChanges([first, second], changes)).toEqual([second, third]);
    expect(taskStarredState(first.id, changes, true)).toBe(false);
    expect(taskStarredState(third.id, changes, false)).toBe(true);
  });

  it("drops the optimistic overlay when its request settles so newer server data wins", () => {
    const oldPage = page("task-1", true);
    const mutationId = publishTaskStarChange({
      page: { ...oldPage, metadata: { ...oldPage.metadata, starred: false } },
      starred: false,
    });

    expect(applyStarredTaskChanges([oldPage], getTaskStarChanges())).toEqual([]);

    const serverPage = { ...oldPage, title: "Renamed on the server", version: 3 };
    clearTaskStarChange(oldPage.id, mutationId);

    expect(getTaskStarChanges()).toEqual([]);
    expect(applyStarredTaskChanges([serverPage], getTaskStarChanges())).toEqual([serverPage]);
  });

  it("keeps a newer page mutation when an older request settles last", () => {
    const first = publishTaskStarChange({ page: page("task-1", false), starred: false });
    const secondPage = { ...page("task-1", true), title: "latest" };
    publishTaskStarChange({ page: secondPage, starred: true });

    clearTaskStarChange("task-1", first);

    expect(getTaskStarChanges()).toEqual([{ page: secondPage, starred: true }]);
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
