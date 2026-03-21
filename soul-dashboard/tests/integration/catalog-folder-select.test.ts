/**
 * 폴더 선택 동작 테스트
 *
 * 이슈 2 재현: 세션 드래그 후 폴더 선택이 안 되는 버그
 * handleSelectFolder와 동일한 로직을 store 레벨에서 테스트한다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import type { CatalogState, SessionSummary } from "@shared/types";

/** 테스트용 카탈로그 생성 헬퍼 */
function makeCatalog(
  sessions: Record<string, { folderId: string | null }>,
): CatalogState {
  return {
    folders: [
      { id: "folder-a", name: "Folder A", sortOrder: 0 },
      { id: "folder-b", name: "Folder B", sortOrder: 1 },
    ],
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([id, { folderId }]) => [
        id,
        { folderId, displayName: null },
      ]),
    ),
  };
}

/** 테스트용 세션 목록 설정 */
function setSessionList(ids: string[]) {
  const store = useDashboardStore.getState();
  const sessions: SessionSummary[] = ids.map((id) => ({
    agentSessionId: id,
    status: "idle" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    eventCount: 0,
  }));
  store.setSessions(sessions);
}

/**
 * handleSelectFolder와 동일한 로직을 재현하는 헬퍼.
 * 컴포넌트 바깥에서 store 레벨로 동일한 동작을 수행한다.
 *
 * 수정 후 코드 기준:
 *   selectFolder(folderId);
 *   const folderSessions = store.getSessionsInFolder(folderId);
 *   if (folderSessions.length > 0) {
 *     store.setActiveSession(folderSessions[0].agentSessionId);
 *   } else {
 *     store.clearActiveSession();
 *   }
 */
function simulateSelectFolder(folderId: string | null) {
  const store = useDashboardStore.getState();
  // 수정 후: selectFolder를 먼저 호출
  store.selectFolder(folderId);
  const folderSessions = store.getSessionsInFolder(folderId);
  if (folderSessions.length > 0) {
    store.setActiveSession(folderSessions[0].agentSessionId);
  } else {
    store.clearActiveSession();
  }
}

describe("폴더 선택 동작", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  it("이슈 2 재현: 세션을 폴더 B로 드래그 후 폴더 B 클릭 → selectedFolderId가 B로 갱신", () => {
    const store = useDashboardStore.getState();

    // 초기 상태: 세션 X가 폴더 A에 있고 활성 상태
    store.setCatalog(makeCatalog({ "session-x": { folderId: "folder-a" } }));
    setSessionList(["session-x"]);
    store.setActiveSession("session-x");

    // 확인: 초기 상태에서 selectedFolderId는 folder-a
    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-a");
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-x");

    // 드래그: 세션 X를 폴더 B로 이동 (낙관적 업데이트)
    store.moveSessionsToFolder(["session-x"], "folder-b");

    // 드래그 후: activeSessionKey는 여전히 session-x, selectedFolderId는 folder-a
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-x");
    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-a");

    // 폴더 B 클릭 (simulateSelectFolder)
    simulateSelectFolder("folder-b");

    // 핵심 검증: selectedFolderId가 folder-b로 갱신되어야 함
    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-b");
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-x");
  });

  it("빈 폴더 선택: selectedFolderId 갱신 + activeSessionKey null", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "session-x": { folderId: "folder-a" } }));
    setSessionList(["session-x"]);
    store.setActiveSession("session-x");

    // 빈 폴더 B 클릭
    simulateSelectFolder("folder-b");

    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-b");
    expect(useDashboardStore.getState().activeSessionKey).toBeNull();
  });

  it("폴더 간 전환: selectedFolderId 정확히 변경", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "session-a": { folderId: "folder-a" },
      "session-b": { folderId: "folder-b" },
    }));
    setSessionList(["session-a", "session-b"]);

    // 폴더 A 선택
    simulateSelectFolder("folder-a");
    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-a");
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-a");

    // 폴더 B로 전환
    simulateSelectFolder("folder-b");
    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-b");
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-b");
  });

  it("미분류(null) 폴더 선택", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "session-a": { folderId: "folder-a" },
      "session-b": { folderId: null },
    }));
    setSessionList(["session-a", "session-b"]);

    // 폴더 A 선택 후 미분류로 전환
    simulateSelectFolder("folder-a");
    expect(useDashboardStore.getState().selectedFolderId).toBe("folder-a");

    simulateSelectFolder(null);
    expect(useDashboardStore.getState().selectedFolderId).toBeNull();
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-b");
  });
});
