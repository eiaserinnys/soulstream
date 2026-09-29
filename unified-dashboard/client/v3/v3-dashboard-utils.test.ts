import { describe, expect, it } from "vitest";
import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";
import {
  AUTH_EXPIRED_MESSAGE,
  buildMobileFolderOptions,
  dateKey,
  errorText,
  reportV3WriteFailure,
  recentDates,
  writeFailureText,
} from "./v3-dashboard-utils";

describe("v3 dashboard utilities", () => {
  it("builds mobile options from every visible folder and includes descendant runs", () => {
    const folders = [folder("folder-1"), folder("folder-2")];
    const sessions = [
      session("run-1", undefined, "2026-07-14T00:00:00.000Z", "folder-1"),
      session("run-child", "run-1", "2026-07-14T01:00:00.000Z", "folder-1"),
    ];

    expect(buildMobileFolderOptions(folders, sessions)).toEqual([{
      folderId: "folder-1",
      runIds: ["run-1", "run-child"],
      latestRunId: "run-1",
    }, { folderId: "folder-2", runIds: [], latestRunId: null }]);
  });

  it("produces stable planner dates and error messages", () => {
    expect(dateKey(new Date(2026, 6, 14))).toBe("2026-07-14");
    expect(recentDates("2026-07-20")).toEqual([
      { date: "2026-07-20", label: "7월 20일 월요일 (오늘)" },
      { date: "2026-07-19", label: "7월 19일 일요일" },
      { date: "2026-07-18", label: "7월 18일 토요일" },
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

function folder(id: string): CatalogFolder {
  return { checklistEnabled: false, status: "open" as const, version: 1, archived: false,  id, name: id, sortOrder: 0 };
}

function session(id: string, callerSessionId: string | undefined, createdAt: string, folderId: string): SessionSummary {
  return {
    agentSessionId: id,
    callerSessionId,
    createdAt,
    folderId,
    status: "completed",
    eventCount: 1,
  };
}
