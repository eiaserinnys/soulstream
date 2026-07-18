import { describe, expect, it, vi } from "vitest";

import type { PlannerTask } from "./planner-data";
import {
  buildMorningRitualQueue,
  dispatchRitualAction,
  selectHistoricalDailyDates,
  type RitualActionPort,
} from "./ritual-model";

describe("selectHistoricalDailyDates", () => {
  it("selects yesterday and one older existing daily page without creating missing dates", () => {
    expect(selectHistoricalDailyDates([
      { daily_date: "2026-07-14" },
      { daily_date: "2026-07-13" },
      { daily_date: null },
      { daily_date: "2026-07-11" },
      { daily_date: "2026-07-10" },
      { daily_date: "2026-07-15" },
    ], "2026-07-14")).toEqual(["2026-07-13", "2026-07-11"]);
  });
});

describe("buildMorningRitualQueue", () => {
  it("collects unfinished mounts from the two previous daily pages without today's duplicates", () => {
    const yesterday = "2026-07-13";
    const older = "2026-07-12";
    const queue = buildMorningRitualQueue({
      historicalDays: [
        {
          date: yesterday,
          tasks: [
            task("task-carry", "계속할 업무", "open"),
            task("task-today", "이미 오늘로 온 업무", "open"),
            task("task-completed", "끝난 업무", "completed"),
            task("task-cancelled", "취소한 업무", "cancelled"),
          ],
        },
        {
          date: older,
          tasks: [
            task("task-carry", "중복 마운트", "open"),
            task("task-older", "이전 최근 업무", "open"),
          ],
        },
      ],
      todayTaskPageIds: new Set(["task-today"]),
    });

    expect(queue.map((item) => item.id)).toEqual([
      "task:task-carry",
      "task:task-older",
    ]);
    expect(queue[0]).toMatchObject({ kind: "task", sourceDate: yesterday });
    expect(queue[1]).toMatchObject({ kind: "task", sourceDate: older });
  });

  it("never includes needs-review sessions in the carryover ritual", () => {
    const queue = buildMorningRitualQueue({
      historicalDays: [],
      todayTaskPageIds: new Set(),
    });

    expect(queue).toEqual([]);
  });
});

describe("dispatchRitualAction", () => {
  it("dispatches today, later, and done for carryover tasks", async () => {
    const port = mockPort();
    const item = buildMorningRitualQueue({
      historicalDays: [{ date: "2026-07-13", tasks: [task("task-1", "업무", "open")] }],
      todayTaskPageIds: new Set(),
    })[0];

    await dispatchRitualAction(item, "today", port);
    expect(port.mountToday).toHaveBeenCalledWith({
      taskTitle: "업무",
    });

    await dispatchRitualAction(item, "later", port);
    expect(port.mountToday).toHaveBeenCalledTimes(1);
    expect(port.completeTask).not.toHaveBeenCalled();

    await dispatchRitualAction(item, "done", port);
    expect(port.completeTask).toHaveBeenCalledWith({
      taskId: "task-task-1",
      expectedVersion: 7,
    });
  });

});

function task(pageId: string, title: string, status: string): PlannerTask {
  return {
    page: {
      id: pageId,
      title,
      daily_date: null,
      version: 1,
      archived: false,
      metadata: {},
      created_at: "2026-07-12T00:00:00Z",
      updated_at: "2026-07-13T00:00:00Z",
    },
    blocks: [],
    stateVector: "",
    taskId: `task-${pageId}`,
    task: {
      task: {
        id: `task-${pageId}`,
        board_item_id: `task:${pageId}`,
        title,
        status: status as "open" | "completed",
        archived: false,
        version: 7,
        created_session_id: null,
        created_event_id: null,
        created_at: "2026-07-12T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      },
      sections: [],
      items: [],
    },
    status: status === "completed" ? "completed" : "open",
    assignee: "로젤린",
    contextCount: 0,
    progress: null,
    projectPageId: null,
    sessionIds: [],
    mountedDocuments: [],
  };
}

function mockPort(): RitualActionPort {
  return {
    mountToday: vi.fn(async () => undefined),
    completeTask: vi.fn(async () => undefined),
  };
}
