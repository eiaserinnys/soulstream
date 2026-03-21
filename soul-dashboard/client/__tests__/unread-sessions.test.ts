/**
 * unread-sessions.test.ts - 실시간 동기화 시나리오 S1~S10
 *
 * 스토어 레벨에서 isSessionUnread, updateSession, SSE 이벤트 핸들링을 검증한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore, isSessionUnread } from "@seosoyoung/soul-ui";
import type { SessionSummary, SessionUpdatedStreamEvent, CatalogState } from "@shared/types";

/** 테스트용 세션 팩토리 */
function makeSession(overrides: Partial<SessionSummary> & { agentSessionId: string }): SessionSummary {
  return {
    status: "running",
    eventCount: 0,
    lastEventId: 0,
    lastReadEventId: 0,
    ...overrides,
  };
}

describe("Unread Sessions - 실시간 동기화", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // S1 - 비활성 세션에 새 이벤트 도착
  it("S1: 비활성 세션의 lastEventId가 lastReadEventId를 초과하면 unread", () => {
    const sessionA = makeSession({ agentSessionId: "A", lastEventId: 5, lastReadEventId: 5 });
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 5, lastReadEventId: 5 });

    useDashboardStore.getState().setSessions([sessionA, sessionB]);
    useDashboardStore.getState().setActiveSession("A");

    // session_updated SSE로 B의 lastEventId 증가
    useDashboardStore.getState().updateSession("B", {
      status: "running",
      lastEventId: 6,
      lastReadEventId: 5,
    });

    const sessions = useDashboardStore.getState().sessions;
    const b = sessions.find((s) => s.agentSessionId === "B")!;
    expect(isSessionUnread(b)).toBe(true);
  });

  // S2 - 활성 세션에 새 이벤트 도착 (debounce) — 스토어 레벨 테스트
  it("S2: 활성 세션의 lastEventId 변경 시 즉시 updateSession으로 읽음 처리 가능", async () => {
    vi.useFakeTimers();

    const sessionA = makeSession({ agentSessionId: "A", lastEventId: 5, lastReadEventId: 5 });
    useDashboardStore.getState().setSessions([sessionA]);

    // lastEventId 증가
    useDashboardStore.getState().updateSession("A", { lastEventId: 6 });

    let a = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "A")!;
    expect(isSessionUnread(a)).toBe(true);

    // 읽음 처리
    useDashboardStore.getState().updateSession("A", { lastReadEventId: 6 });

    a = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "A")!;
    expect(isSessionUnread(a)).toBe(false);

    vi.useRealTimers();
  });

  // S3 - 신규 세션
  it("S3: 신규 세션은 lastEventId=0이면 unread가 아님, 이벤트 도착 후 unread", () => {
    const sessionA = makeSession({ agentSessionId: "A", lastEventId: 3, lastReadEventId: 3 });
    useDashboardStore.getState().setSessions([sessionA]);

    // 신규 세션 추가 (lastEventId=0)
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 0, lastReadEventId: 0 });
    useDashboardStore.getState().addSession(sessionB);

    let b = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "B")!;
    expect(isSessionUnread(b)).toBe(false);

    // 이벤트 도착
    useDashboardStore.getState().updateSession("B", { lastEventId: 1 });

    b = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "B")!;
    expect(isSessionUnread(b)).toBe(true);
  });

  // S4 - 세션 삭제
  it("S4: unread 세션 삭제 후 sessions에서 제거됨", () => {
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 6, lastReadEventId: 5 });
    useDashboardStore.getState().setSessions([sessionB]);

    expect(isSessionUnread(sessionB)).toBe(true);

    useDashboardStore.getState().removeSession("B");

    const sessions = useDashboardStore.getState().sessions;
    expect(sessions.find((s) => s.agentSessionId === "B")).toBeUndefined();
  });

  // S5 - 세션 선택 (읽음 처리) — 스토어 레벨
  it("S5: 세션 선택 후 updateSession으로 lastReadEventId를 갱신하면 unread 해제", () => {
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 6, lastReadEventId: 5 });
    useDashboardStore.getState().setSessions([sessionB]);

    expect(isSessionUnread(sessionB)).toBe(true);

    // 읽음 처리 (useReadPositionSync가 하는 일)
    useDashboardStore.getState().updateSession("B", { lastReadEventId: 6 });

    const b = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "B")!;
    expect(isSessionUnread(b)).toBe(false);
  });

  // S6 - SSE 재연결
  it("S6: SSE 재연결 후 session_list 수신 시 unread 상태 반영", () => {
    // SSE 재연결 후 setSessions로 전체 목록 수신
    const sessions = [
      makeSession({ agentSessionId: "A", lastEventId: 10, lastReadEventId: 5 }),
      makeSession({ agentSessionId: "B", lastEventId: 3, lastReadEventId: 3 }),
    ];
    useDashboardStore.getState().setSessions(sessions);

    const a = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "A")!;
    const b = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "B")!;
    expect(isSessionUnread(a)).toBe(true);
    expect(isSessionUnread(b)).toBe(false);
  });

  // S7 - 크로스 대시보드 동기화
  it("S7: session_updated로 last_read_event_id 갱신 시 unread 해제", () => {
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 6, lastReadEventId: 5 });
    useDashboardStore.getState().setSessions([sessionB]);

    expect(isSessionUnread(sessionB)).toBe(true);

    // 다른 대시보드에서 읽음 처리 → SSE로 전파
    useDashboardStore.getState().updateSession("B", { lastReadEventId: 6 });

    const b = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "B")!;
    expect(isSessionUnread(b)).toBe(false);
  });

  // S8 - 초기 로드
  it("S8: GET /sessions 초기 로드 시 lastEventId > lastReadEventId인 세션만 unread", () => {
    const sessions = [
      makeSession({ agentSessionId: "A", lastEventId: 10, lastReadEventId: 10 }),
      makeSession({ agentSessionId: "B", lastEventId: 5, lastReadEventId: 3 }),
      makeSession({ agentSessionId: "C", lastEventId: 0, lastReadEventId: 0 }),
    ];
    useDashboardStore.getState().setSessions(sessions);

    const stored = useDashboardStore.getState().sessions;
    expect(isSessionUnread(stored.find((s) => s.agentSessionId === "A")!)).toBe(false);
    expect(isSessionUnread(stored.find((s) => s.agentSessionId === "B")!)).toBe(true);
    expect(isSessionUnread(stored.find((s) => s.agentSessionId === "C")!)).toBe(false);
  });

  // S9 - 빠른 연속 이벤트
  it("S9: 빠른 연속 updateSession 후 최종 lastEventId가 반영됨", () => {
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 5, lastReadEventId: 5 });
    useDashboardStore.getState().setSessions([sessionB]);

    // 50ms 간격의 빠른 연속 이벤트를 스토어 레벨에서 시뮬레이션
    useDashboardStore.getState().updateSession("B", { lastEventId: 6 });
    useDashboardStore.getState().updateSession("B", { lastEventId: 7 });
    useDashboardStore.getState().updateSession("B", { lastEventId: 8 });

    const b = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "B")!;
    expect(b.lastEventId).toBe(8);
    expect(isSessionUnread(b)).toBe(true);
  });

  // S10 - 폴더 간 세션 이동
  it("S10: catalog_updated로 세션 폴더 이동 시 unread count 변경", () => {
    const sessionB = makeSession({ agentSessionId: "B", lastEventId: 6, lastReadEventId: 5 });
    useDashboardStore.getState().setSessions([sessionB]);

    // 초기 카탈로그: B는 폴더 X에 소속
    const catalogX: CatalogState = {
      folders: [
        { id: "X", name: "FolderX", sortOrder: 0 },
        { id: "Y", name: "FolderY", sortOrder: 1 },
      ],
      sessions: {
        B: { folderId: "X", displayName: null },
      },
    };
    useDashboardStore.getState().setCatalog(catalogX);

    // getSessionsInFolder로 폴더별 세션 확인
    let xSessions = useDashboardStore.getState().getSessionsInFolder("X");
    let ySessions = useDashboardStore.getState().getSessionsInFolder("Y");
    expect(xSessions.filter(isSessionUnread).length).toBe(1);
    expect(ySessions.filter(isSessionUnread).length).toBe(0);

    // catalog_updated: B를 폴더 Y로 이동
    const catalogY: CatalogState = {
      folders: [
        { id: "X", name: "FolderX", sortOrder: 0 },
        { id: "Y", name: "FolderY", sortOrder: 1 },
      ],
      sessions: {
        B: { folderId: "Y", displayName: null },
      },
    };
    useDashboardStore.getState().setCatalog(catalogY);

    xSessions = useDashboardStore.getState().getSessionsInFolder("X");
    ySessions = useDashboardStore.getState().getSessionsInFolder("Y");
    expect(xSessions.filter(isSessionUnread).length).toBe(0);
    expect(ySessions.filter(isSessionUnread).length).toBe(1);
  });
});
