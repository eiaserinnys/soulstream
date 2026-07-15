import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

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
      sessions: [],
    });

    expect(queue.map((item) => item.id)).toEqual([
      "task:task-carry",
      "task:task-older",
    ]);
    expect(queue[0]).toMatchObject({ kind: "task", sourceDate: yesterday });
    expect(queue[1]).toMatchObject({ kind: "task", sourceDate: older });
  });

  it("appends only needs-review sessions from the planner session source", () => {
    const queue = buildMorningRitualQueue({
      historicalDays: [],
      todayTaskPageIds: new Set(),
      sessions: [
        session("review-me", "needs_review"),
        session("already-seen", "acknowledged"),
      ],
    });

    expect(queue.map((item) => item.id)).toEqual(["review:review-me"]);
  });

  it("turns an unnamed session prompt into a single-line title preview capped at 120 code points", () => {
    const prompt = `  ${"장문 프롬프트와 JSON 조각\n".repeat(40)}  `;
    const queue = buildMorningRitualQueue({
      historicalDays: [],
      todayTaskPageIds: new Set(),
      sessions: [{
        ...session("long-review", "needs_review"),
        displayName: "  ",
        prompt,
      }],
    });

    expect(queue).toHaveLength(1);
    expect(queue[0]?.title).not.toContain("\n");
    expect(Array.from(queue[0]?.title ?? "")).toHaveLength(120);
    expect(queue[0]?.title.endsWith("…")).toBe(true);
    expect(queue[0]?.title).not.toBe(prompt);
  });
});

describe("dispatchRitualAction", () => {
  it("dispatches today, later, and done for carryover tasks", async () => {
    const port = mockPort();
    const item = buildMorningRitualQueue({
      historicalDays: [{ date: "2026-07-13", tasks: [task("task-1", "업무", "open")] }],
      todayTaskPageIds: new Set(),
      sessions: [],
    })[0];

    await dispatchRitualAction(item, "today", port);
    expect(port.mountToday).toHaveBeenCalledWith({
      taskTitle: "업무",
    });

    await dispatchRitualAction(item, "later", port);
    expect(port.mountToday).toHaveBeenCalledTimes(1);
    expect(port.completeRunbook).not.toHaveBeenCalled();
    expect(port.acknowledgeReview).not.toHaveBeenCalled();

    await dispatchRitualAction(item, "done", port);
    expect(port.completeRunbook).toHaveBeenCalledWith({
      runbookId: "runbook-task-1",
      expectedVersion: 7,
    });
  });

  it("defers review chat navigation and dispatches review acknowledgement", async () => {
    const port = mockPort();
    const item = buildMorningRitualQueue({
      historicalDays: [],
      todayTaskPageIds: new Set(),
      sessions: [session("review-me", "needs_review")],
    })[0];

    await expect(dispatchRitualAction(item, "chat", port)).resolves.toEqual({
      openSessionId: "review-me",
    });
    expect(port.acknowledgeReview).not.toHaveBeenCalled();

    await dispatchRitualAction(item, "acknowledge", port);
    expect(port.acknowledgeReview).toHaveBeenCalledWith("review-me");
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
    runbookId: `runbook-${pageId}`,
    runbook: {
      runbook: {
        id: `runbook-${pageId}`,
        board_item_id: `runbook:${pageId}`,
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

function session(agentSessionId: string, reviewState: "needs_review" | "acknowledged"): SessionSummary {
  return {
    agentSessionId,
    status: "completed",
    reviewState,
    eventCount: 1,
    displayName: "검수 세션",
    agentName: "서소영",
  };
}

function mockPort(): RitualActionPort {
  return {
    mountToday: vi.fn(async () => undefined),
    completeRunbook: vi.fn(async () => undefined),
    acknowledgeReview: vi.fn(async () => undefined),
  };
}
