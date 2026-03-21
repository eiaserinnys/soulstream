/**
 * catalog renameSession 낙관적 업데이트 + 롤백 테스트
 *
 * renameSessionOptimistic의 낙관적 업데이트 → API → 실패 시 롤백 패턴을 검증한다.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import type { CatalogState } from "@shared/types";

/** 테스트용 카탈로그 생성 헬퍼 */
function makeCatalog(
  sessions: Record<string, { folderId: string | null; displayName?: string | null }>,
): CatalogState {
  return {
    folders: [
      { id: "folder-a", name: "Folder A", sortOrder: 0 },
    ],
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([id, { folderId, displayName }]) => [
        id,
        { folderId, displayName: displayName ?? null },
      ]),
    ),
  };
}

describe("renameSession", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === 기본 동작 ===

  it("기본 리네임: displayName 변경 후 catalogVersion 증가", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null, displayName: "Old Name" } }));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.renameSession("s1", "New Name");

    const state = useDashboardStore.getState();
    expect(state.catalog!.sessions["s1"].displayName).toBe("New Name");
    expect(state.catalogVersion).toBe(vBefore + 1);
  });

  it("null로 리네임(이름 삭제): displayName을 null로 설정", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null, displayName: "Some Name" } }));

    store.renameSession("s1", null);

    expect(useDashboardStore.getState().catalog!.sessions["s1"].displayName).toBeNull();
  });

  it("존재하지 않는 세션 ID: 에러 없이 무시, catalogVersion 불변", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null } }));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.renameSession("nonexistent", "Name");

    expect(useDashboardStore.getState().catalogVersion).toBe(vBefore);
  });

  it("catalog이 null일 때: 에러 없이 무시", () => {
    // reset 후 catalog은 null
    expect(() => {
      useDashboardStore.getState().renameSession("s1", "Name");
    }).not.toThrow();
  });
});

describe("renameSessionOptimistic 롤백", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("API 실패 → 이전 displayName으로 롤백", async () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null, displayName: "Original" } }));

    // fetch mock: 실패 응답
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { renameSessionOptimistic } = await import("client/lib/rename-session");
    await renameSessionOptimistic("s1", "New Name");

    // 롤백 확인
    expect(useDashboardStore.getState().catalog!.sessions["s1"].displayName).toBe("Original");
  });

  it("null에서 이름 부여 후 실패 → null로 롤백", async () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null, displayName: null } }));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { renameSessionOptimistic } = await import("client/lib/rename-session");
    await renameSessionOptimistic("s1", "Named");

    expect(useDashboardStore.getState().catalog!.sessions["s1"].displayName).toBeNull();
  });

  it("이름에서 null로 변경 후 실패 → 이전 이름으로 롤백", async () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null, displayName: "Keep This" } }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { renameSessionOptimistic } = await import("client/lib/rename-session");
    await renameSessionOptimistic("s1", null);

    expect(useDashboardStore.getState().catalog!.sessions["s1"].displayName).toBe("Keep This");
  });
});

describe("renameSession SSE 정합성", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  it("낙관적 리네임 후 SSE setCatalog이 서버 정본으로 덮어쓴다", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: null, displayName: "Old" } }));

    // 낙관적 업데이트
    store.renameSession("s1", "Optimistic Name");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].displayName).toBe("Optimistic Name");

    // SSE 이벤트: 서버 정본 도착
    const serverCatalog: CatalogState = {
      folders: [{ id: "folder-a", name: "Folder A", sortOrder: 0 }],
      sessions: {
        "s1": { folderId: null, displayName: "Server Truth" },
      },
    };
    useDashboardStore.getState().setCatalog(serverCatalog);

    // 서버 정본이 덮어쓰기
    expect(useDashboardStore.getState().catalog!.sessions["s1"].displayName).toBe("Server Truth");
  });
});
