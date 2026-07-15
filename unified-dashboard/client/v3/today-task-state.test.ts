import { describe, expect, it, vi } from "vitest";

import {
  runOptimisticTodayMutation,
  todayPlannerMenuLabel,
  visibleDailyTasks,
} from "./today-task-state";

describe("today task state", () => {
  it("uses a state-aware context-menu label", () => {
    expect(todayPlannerMenuLabel(true)).toBe("오늘 플래너에서 제거");
    expect(todayPlannerMenuLabel(false)).toBe("오늘 플래너에 추가");
  });

  it("immediately hides removed and completed tasks only in today's view", () => {
    const tasks = [
      task("open", "open"),
      task("removed", "open"),
      task("completed", "completed"),
    ];

    expect(visibleDailyTasks(tasks, true, new Set(["open", "completed"])).map((item) => item.page.id))
      .toEqual(["open"]);
    expect(visibleDailyTasks(tasks, false, new Set()).map((item) => item.page.id))
      .toEqual(["open", "removed", "completed"]);
  });

  it("applies before awaiting and restores membership when the request fails", async () => {
    const changes: Array<[string, boolean]> = [];
    let rejectRequest: ((error: Error) => void) | undefined;
    const request = new Promise<"removed">((_, reject) => { rejectRequest = reject; });

    const pending = runOptimisticTodayMutation({
      taskId: "task-a",
      wasInToday: true,
      optimisticInToday: false,
      setPresence: (taskId, present) => changes.push([taskId, present]),
      mutate: () => request,
      finalPresence: () => false,
    });

    expect(changes).toEqual([["task-a", false]]);
    rejectRequest?.(new Error("실패"));
    await expect(pending).rejects.toThrow("실패");
    expect(changes).toEqual([["task-a", false], ["task-a", true]]);
  });

  it("settles membership from the mutation result", async () => {
    const setPresence = vi.fn();

    await expect(runOptimisticTodayMutation({
      taskId: "task-a",
      wasInToday: false,
      optimisticInToday: true,
      setPresence,
      mutate: async () => "removed" as const,
      finalPresence: () => false,
    })).resolves.toBe("removed");

    expect(setPresence.mock.calls).toEqual([
      ["task-a", true],
      ["task-a", false],
    ]);
  });
});

function task(id: string, status: "open" | "completed") {
  return {
    page: { id },
    status,
  };
}
