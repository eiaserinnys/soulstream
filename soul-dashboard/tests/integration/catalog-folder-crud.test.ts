/**
 * catalog 폴더 CRUD 낙관적 업데이트 store 액션 테스트
 *
 * addFolder, updateFolderName, removeFolder 액션의 동작과 롤백 시나리오를 검증한다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import type { CatalogState } from "@shared/types";

/** 테스트용 카탈로그 생성 헬퍼 */
function makeCatalog(
  folders: Array<{ id: string; name: string; sortOrder: number }>,
  sessions: Record<string, { folderId: string | null; displayName?: string | null }> = {},
): CatalogState {
  return {
    folders,
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([id, { folderId, displayName }]) => [
        id,
        { folderId, displayName: displayName ?? null },
      ]),
    ),
  };
}

const DEFAULT_FOLDERS = [
  { id: "folder-a", name: "Folder A", sortOrder: 0 },
  { id: "folder-b", name: "Folder B", sortOrder: 1 },
];

describe("addFolder", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  it("정상 추가: folders 배열에 추가됨 + catalogVersion 증가", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.addFolder({ id: "folder-c", name: "Folder C", sortOrder: 2 });

    const state = useDashboardStore.getState();
    expect(state.catalog!.folders).toHaveLength(3);
    expect(state.catalog!.folders[2]).toEqual({ id: "folder-c", name: "Folder C", sortOrder: 2 });
    expect(state.catalogVersion).toBe(vBefore + 1);
  });

  it("기존 폴더에 영향 없음", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS));

    store.addFolder({ id: "folder-c", name: "Folder C", sortOrder: 2 });

    const folders = useDashboardStore.getState().catalog!.folders;
    expect(folders[0]).toEqual(DEFAULT_FOLDERS[0]);
    expect(folders[1]).toEqual(DEFAULT_FOLDERS[1]);
  });

  it("catalog null: 에러 없이 무시", () => {
    const store = useDashboardStore.getState();
    // catalog 설정하지 않음 (null)
    expect(() => store.addFolder({ id: "folder-a", name: "A", sortOrder: 0 })).not.toThrow();
  });
});

describe("updateFolderName", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  it("정상 변경: 해당 폴더의 name 갱신 + catalogVersion 증가", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.updateFolderName("folder-a", "Renamed A");

    const state = useDashboardStore.getState();
    expect(state.catalog!.folders.find((f) => f.id === "folder-a")!.name).toBe("Renamed A");
    expect(state.catalogVersion).toBe(vBefore + 1);
  });

  it("다른 폴더에 영향 없음", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS));

    store.updateFolderName("folder-a", "Renamed A");

    expect(useDashboardStore.getState().catalog!.folders.find((f) => f.id === "folder-b")!.name).toBe("Folder B");
  });

  it("존재하지 않는 folderId: 에러 없이 무시, 다른 폴더 영향 없음", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS));

    expect(() => store.updateFolderName("nonexistent", "New Name")).not.toThrow();
    const folders = useDashboardStore.getState().catalog!.folders;
    expect(folders[0].name).toBe("Folder A");
    expect(folders[1].name).toBe("Folder B");
  });

  it("catalog null: 에러 없이 무시", () => {
    const store = useDashboardStore.getState();
    expect(() => store.updateFolderName("folder-a", "New")).not.toThrow();
  });
});

describe("removeFolder", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  it("정상 삭제: folders에서 제거 + 해당 폴더 세션 folderId=null + catalogVersion 증가", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS, {
      "s1": { folderId: "folder-a" },
      "s2": { folderId: "folder-a" },
    }));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.removeFolder("folder-a");

    const state = useDashboardStore.getState();
    expect(state.catalog!.folders).toHaveLength(1);
    expect(state.catalog!.folders[0].id).toBe("folder-b");
    expect(state.catalog!.sessions["s1"].folderId).toBeNull();
    expect(state.catalog!.sessions["s2"].folderId).toBeNull();
    expect(state.catalogVersion).toBe(vBefore + 1);
  });

  it("다른 폴더 세션에 영향 없음", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS, {
      "s1": { folderId: "folder-a" },
      "s2": { folderId: "folder-b" },
    }));

    store.removeFolder("folder-a");

    expect(useDashboardStore.getState().catalog!.sessions["s2"].folderId).toBe("folder-b");
  });

  it("빈 폴더(세션 0개) 삭제: folders에서만 제거, 세션 변경 없음", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS, {
      "s1": { folderId: "folder-b" },
    }));

    store.removeFolder("folder-a");

    const state = useDashboardStore.getState();
    expect(state.catalog!.folders).toHaveLength(1);
    expect(state.catalog!.sessions["s1"].folderId).toBe("folder-b");
  });

  it("catalog null: 에러 없이 무시", () => {
    const store = useDashboardStore.getState();
    expect(() => store.removeFolder("folder-a")).not.toThrow();
  });

  it("삭제 후 SSE setCatalog이 서버 정본으로 덮어쓴다", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog(DEFAULT_FOLDERS, {
      "s1": { folderId: "folder-a" },
    }));

    // 낙관적 삭제
    store.removeFolder("folder-a");
    expect(useDashboardStore.getState().catalog!.folders).toHaveLength(1);

    // SSE로 서버 정본 도착 (서버에서도 삭제 완료)
    store.setCatalog(makeCatalog(
      [{ id: "folder-b", name: "Folder B", sortOrder: 0 }],
      { "s1": { folderId: null } },
    ));

    const state = useDashboardStore.getState();
    expect(state.catalog!.folders).toHaveLength(1);
    expect(state.catalog!.folders[0].id).toBe("folder-b");
  });
});
