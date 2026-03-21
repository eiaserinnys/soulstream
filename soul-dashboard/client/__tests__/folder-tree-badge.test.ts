/**
 * folder-tree-badge.test.ts - 폴더 트리 배지 로직 테스트 B1~B4
 *
 * FolderTree의 배지 표시 로직을 스토어 레벨에서 검증한다.
 * (React Testing Library 없이 순수 로직 테스트)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore, isSessionUnread } from "@seosoyoung/soul-ui";
import type { SessionSummary, CatalogState } from "@shared/types";

function makeSession(overrides: Partial<SessionSummary> & { agentSessionId: string }): SessionSummary {
  return {
    status: "running",
    eventCount: 0,
    lastEventId: 0,
    lastReadEventId: 0,
    ...overrides,
  };
}

/** FolderTree의 getUnreadCount 로직을 재현 */
function getUnreadCount(folderId: string | null): number {
  const { sessions, catalog } = useDashboardStore.getState();
  if (!catalog) return 0;
  return sessions.filter((s) => {
    const assignment = catalog.sessions[s.agentSessionId];
    if (folderId === null) {
      return (!assignment || assignment.folderId === null) && isSessionUnread(s);
    }
    return assignment?.folderId === folderId && isSessionUnread(s);
  }).length;
}

/** FolderTree의 getSessionCount 로직을 재현 */
function getSessionCount(folderId: string | null): number {
  const { sessions, catalog } = useDashboardStore.getState();
  if (!catalog) return 0;
  return sessions.filter((s) => {
    const assignment = catalog.sessions[s.agentSessionId];
    if (folderId === null) {
      return !assignment || assignment.folderId === null;
    }
    return assignment?.folderId === folderId;
  }).length;
}

describe("FolderTree Badge - 배지 로직", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // B1 - unread 0개 → 전체 세션 수 표시 (secondary variant)
  it("B1: unread 0개일 때 getUnreadCount=0, getSessionCount는 전체 수 반환", () => {
    const sessions = [
      makeSession({ agentSessionId: "A", lastEventId: 5, lastReadEventId: 5 }),
      makeSession({ agentSessionId: "B", lastEventId: 3, lastReadEventId: 3 }),
    ];
    useDashboardStore.getState().setSessions(sessions);

    const catalog: CatalogState = {
      folders: [{ id: "F1", name: "Folder1", sortOrder: 0 }],
      sessions: {
        A: { folderId: "F1", displayName: null },
        B: { folderId: "F1", displayName: null },
      },
    };
    useDashboardStore.getState().setCatalog(catalog);

    expect(getUnreadCount("F1")).toBe(0);
    expect(getSessionCount("F1")).toBe(2);
    // UI: Badge variant="secondary", 표시: 2
  });

  // B2 - unread 1개 이상 → unread 수 표시 (destructive variant)
  it("B2: unread 1개 이상일 때 getUnreadCount > 0", () => {
    const sessions = [
      makeSession({ agentSessionId: "A", lastEventId: 5, lastReadEventId: 5 }),
      makeSession({ agentSessionId: "B", lastEventId: 6, lastReadEventId: 3 }),
      makeSession({ agentSessionId: "C", lastEventId: 10, lastReadEventId: 8 }),
    ];
    useDashboardStore.getState().setSessions(sessions);

    const catalog: CatalogState = {
      folders: [{ id: "F1", name: "Folder1", sortOrder: 0 }],
      sessions: {
        A: { folderId: "F1", displayName: null },
        B: { folderId: "F1", displayName: null },
        C: { folderId: "F1", displayName: null },
      },
    };
    useDashboardStore.getState().setCatalog(catalog);

    expect(getUnreadCount("F1")).toBe(2); // B와 C가 unread
    // UI: Badge variant="destructive" + font-bold, 표시: 2
  });

  // B3 - 미분류 폴더 unread count
  it("B3: 미분류 폴더의 unread count 정확성", () => {
    const sessions = [
      makeSession({ agentSessionId: "A", lastEventId: 5, lastReadEventId: 5 }),
      makeSession({ agentSessionId: "B", lastEventId: 6, lastReadEventId: 3 }),
    ];
    useDashboardStore.getState().setSessions(sessions);

    const catalog: CatalogState = {
      folders: [{ id: "F1", name: "Folder1", sortOrder: 0 }],
      sessions: {
        A: { folderId: "F1", displayName: null },
        // B는 카탈로그에 없음 → 미분류
      },
    };
    useDashboardStore.getState().setCatalog(catalog);

    expect(getUnreadCount(null)).toBe(1); // B만 미분류 + unread
    expect(getUnreadCount("F1")).toBe(0); // A는 read
  });

  // B4 - isSessionUnread 경계 조건
  it("B4: isSessionUnread 경계 조건 — lastEventId === lastReadEventId이면 read", () => {
    expect(isSessionUnread(makeSession({ agentSessionId: "X", lastEventId: 0, lastReadEventId: 0 }))).toBe(false);
    expect(isSessionUnread(makeSession({ agentSessionId: "X", lastEventId: 5, lastReadEventId: 5 }))).toBe(false);
    expect(isSessionUnread(makeSession({ agentSessionId: "X", lastEventId: 6, lastReadEventId: 5 }))).toBe(true);
    expect(isSessionUnread(makeSession({ agentSessionId: "X", lastEventId: 1, lastReadEventId: 0 }))).toBe(true);
  });
});
