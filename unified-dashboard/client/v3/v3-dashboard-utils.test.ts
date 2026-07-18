import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import {
  AUTH_EXPIRED_MESSAGE,
  buildMobileTaskOptions,
  dateKey,
  errorText,
  reportV3WriteFailure,
  recentDates,
  writeFailureText,
} from "./v3-dashboard-utils";

describe("v3 dashboard utilities", () => {
  it("builds one mobile option per task and includes descendant runs", () => {
    const tasks = [
      task("task-1", ["run-1", "run-child"]),
      task("task-1", ["run-1", "run-child"]),
    ];
    const sessions = [
      session("run-1", undefined, "2026-07-14T00:00:00.000Z"),
      session("run-child", "run-1", "2026-07-14T01:00:00.000Z"),
    ];

    expect(buildMobileTaskOptions(tasks, sessions)).toEqual([{
      taskId: "task-1",
      runIds: ["run-1", "run-child"],
      latestRunId: "run-1",
    }]);
  });

  it("produces stable planner dates and error messages", () => {
    expect(dateKey(new Date(2026, 6, 14))).toBe("2026-07-14");
    expect(recentDates("2026-07-14").map((item) => item.date)).toEqual([
      "2026-07-14",
      "2026-07-13",
      "2026-07-12",
    ]);
    expect(errorText(new Error("실패"))).toBe("실패");
    expect(errorText("문자열 오류")).toBe("문자열 오류");
  });

  it("uses one 401 write boundary to show expiry and refresh the existing auth flow", () => {
    const messages: string[] = [];
    let authRefreshes = 0;
    const error = Object.assign(new Error("Dashboard user is required"), { status: 401 });

    expect(writeFailureText("새 업무 생성", error)).toBe(AUTH_EXPIRED_MESSAGE);
    expect(reportV3WriteFailure({
      action: "새 업무 생성",
      error,
      notify: (message) => messages.push(message),
      refreshAuthStatus: () => { authRefreshes += 1; },
    })).toBe(AUTH_EXPIRED_MESSAGE);

    expect(messages).toEqual([AUTH_EXPIRED_MESSAGE]);
    expect(authRefreshes).toBe(1);
    expect(writeFailureText("업무 저장", new Error("충돌"))).toBe("업무 저장 실패 · 충돌");
    expect(writeFailureText("세션 삭제", new Error("Failed to delete session: 401")))
      .toBe(AUTH_EXPIRED_MESSAGE);
    expect(writeFailureText(
      "새 업무 생성",
      Object.assign(new Error("업무 생성 실패"), { cause: error }),
    )).toBe(AUTH_EXPIRED_MESSAGE);
  });
});

function task(id: string, sessionIds: string[]): PlannerTask {
  return {
    page: { id },
    sessionIds,
  } as PlannerTask;
}

function session(id: string, callerSessionId: string | undefined, createdAt: string): SessionSummary {
  return {
    agentSessionId: id,
    callerSessionId,
    createdAt,
    status: "completed",
    eventCount: 1,
  };
}
