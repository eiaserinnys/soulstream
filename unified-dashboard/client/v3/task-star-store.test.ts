import { describe, expect, it } from "vitest";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import {
  applyStarredTaskChanges,
  taskStarredState,
  type TaskStarChange,
} from "./task-star-store";

describe("task star projection", () => {
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
