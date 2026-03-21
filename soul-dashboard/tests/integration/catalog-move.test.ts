/**
 * catalog moveSessionsToFolder 낙관적 업데이트 + 롤백 테스트
 *
 * 롤백은 자주 발생하지 않아 버그 발견이 어렵다.
 * 다양한 폴더 조합과 실패 시나리오를 까다롭게 검증한다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import type { CatalogState } from "@shared/types";

/** 테스트용 카탈로그 생성 헬퍼 */
function makeCatalog(
  sessions: Record<string, { folderId: string | null; displayName?: string | null }>,
): CatalogState {
  return {
    folders: [
      { id: "folder-a", name: "Folder A", sortOrder: 0 },
      { id: "folder-b", name: "Folder B", sortOrder: 1 },
      { id: "folder-c", name: "Folder C", sortOrder: 2 },
    ],
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([id, { folderId, displayName }]) => [
        id,
        { folderId, displayName: displayName ?? null },
      ]),
    ),
  };
}

describe("moveSessionsToFolder", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === 기본 동작 ===

  it("단일 세션 이동: folderId 변경 후 catalogVersion 증가", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: "folder-a" } }));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.moveSessionsToFolder(["s1"], "folder-b");

    const state = useDashboardStore.getState();
    expect(state.catalog!.sessions["s1"].folderId).toBe("folder-b");
    expect(state.catalogVersion).toBe(vBefore + 1);
  });

  it("다중 세션 이동: 3개 세션 모두 folderId 변경", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
      "s2": { folderId: "folder-a" },
      "s3": { folderId: "folder-b" },
    }));

    store.moveSessionsToFolder(["s1", "s2", "s3"], "folder-c");

    const sessions = useDashboardStore.getState().catalog!.sessions;
    expect(sessions["s1"].folderId).toBe("folder-c");
    expect(sessions["s2"].folderId).toBe("folder-c");
    expect(sessions["s3"].folderId).toBe("folder-c");
  });

  it("존재하지 않는 세션 ID: 에러 없이 무시", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: "folder-a" } }));

    // 존재하지 않는 ID로 호출해도 에러 없음
    expect(() => store.moveSessionsToFolder(["nonexistent"], "folder-b")).not.toThrow();
    // 기존 세션은 영향받지 않음
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-a");
  });

  it("catalog이 null일 때: 에러 없이 무시", () => {
    const store = useDashboardStore.getState();
    // catalog 설정하지 않음 (null)
    expect(() => store.moveSessionsToFolder(["s1"], "folder-a")).not.toThrow();
  });

  it("null 폴더(미분류)로 이동", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: "folder-a" } }));

    store.moveSessionsToFolder(["s1"], null);

    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBeNull();
  });

  // === 롤백 시나리오 ===

  it("단일 세션 API 실패 → 롤백: 원래 폴더로 복원", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: "folder-a" } }));

    // 낙관적 이동
    store.moveSessionsToFolder(["s1"], "folder-b");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-b");

    // API 실패 → 롤백
    store.moveSessionsToFolder(["s1"], "folder-a");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-a");
  });

  it("다중 세션 API 실패 → 롤백: 각각 원래 폴더로 복원", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
      "s2": { folderId: "folder-a" },
      "s3": { folderId: "folder-b" },
    }));

    // 스냅샷 저장
    const prev: Record<string, string | null> = {
      "s1": "folder-a",
      "s2": "folder-a",
      "s3": "folder-b",
    };

    // 낙관적 이동
    store.moveSessionsToFolder(["s1", "s2", "s3"], "folder-c");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-c");
    expect(useDashboardStore.getState().catalog!.sessions["s2"].folderId).toBe("folder-c");
    expect(useDashboardStore.getState().catalog!.sessions["s3"].folderId).toBe("folder-c");

    // 롤백: 각자 원래 폴더로
    for (const [id, folderId] of Object.entries(prev)) {
      store.moveSessionsToFolder([id], folderId);
    }
    const sessions = useDashboardStore.getState().catalog!.sessions;
    expect(sessions["s1"].folderId).toBe("folder-a");
    expect(sessions["s2"].folderId).toBe("folder-a");
    expect(sessions["s3"].folderId).toBe("folder-b");
  });

  it("서로 다른 원본 폴더에서 온 다중 세션 롤백", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
      "s2": { folderId: "folder-b" },
      "s3": { folderId: "folder-c" },
    }));

    const prev: Record<string, string | null> = {
      "s1": "folder-a",
      "s2": "folder-b",
      "s3": "folder-c",
    };

    // 세 개 모두 folder-a로 이동
    store.moveSessionsToFolder(["s1", "s2", "s3"], "folder-a");

    // 롤백
    for (const [id, folderId] of Object.entries(prev)) {
      store.moveSessionsToFolder([id], folderId);
    }
    const sessions = useDashboardStore.getState().catalog!.sessions;
    expect(sessions["s1"].folderId).toBe("folder-a");
    expect(sessions["s2"].folderId).toBe("folder-b");
    expect(sessions["s3"].folderId).toBe("folder-c");
  });

  it("미분류(folderId=null) 세션의 롤백: null로 정확히 복원", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: null },
    }));

    // 미분류 → 폴더로 이동
    store.moveSessionsToFolder(["s1"], "folder-a");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-a");

    // 롤백: null로 복원
    store.moveSessionsToFolder(["s1"], null);
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBeNull();
  });

  it("폴더에서 미분류로 이동 실패 시 롤백", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
    }));

    // 폴더 → 미분류로 이동
    store.moveSessionsToFolder(["s1"], null);
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBeNull();

    // 롤백: 원래 폴더로
    store.moveSessionsToFolder(["s1"], "folder-a");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-a");
  });

  it("빈 선택(ids=[])으로 이동 시도: 상태 변경 없음", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
    }));
    const vBefore = useDashboardStore.getState().catalogVersion;

    store.moveSessionsToFolder([], "folder-b");

    // catalogVersion 미변경, 세션 데이터도 변경 없음
    expect(useDashboardStore.getState().catalogVersion).toBe(vBefore);
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-a");
  });

  // === 복합 시나리오 ===

  it("낙관적 이동 후 SSE setCatalog이 서버 정본으로 덮어쓴다", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
      "s2": { folderId: "folder-a" },
    }));

    // 낙관적 이동
    store.moveSessionsToFolder(["s1"], "folder-b");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-b");

    // SSE로 서버 정본 도착 (서버에서는 이미 folder-b)
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-b" },
      "s2": { folderId: "folder-a" },
    }));

    const sessions = useDashboardStore.getState().catalog!.sessions;
    expect(sessions["s1"].folderId).toBe("folder-b");
    expect(sessions["s2"].folderId).toBe("folder-a");
  });

  it("연속 이동: A→B→C 후 롤백하면 B(두 번째 이동의 원본)로 복원", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({ "s1": { folderId: "folder-a" } }));

    // 첫 번째 이동 (성공 가정)
    store.moveSessionsToFolder(["s1"], "folder-b");

    // 두 번째 이동의 스냅샷 시점에서 s1은 folder-b
    const prevForSecondMove = useDashboardStore.getState().catalog!.sessions["s1"].folderId;
    expect(prevForSecondMove).toBe("folder-b");

    // 두 번째 이동
    store.moveSessionsToFolder(["s1"], "folder-c");
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-c");

    // 두 번째 이동 실패 → 롤백: folder-b로 (folder-a가 아님!)
    store.moveSessionsToFolder(["s1"], prevForSecondMove);
    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-b");
  });

  it("혼합: 존재하는 세션과 존재하지 않는 세션을 함께 이동", () => {
    const store = useDashboardStore.getState();
    store.setCatalog(makeCatalog({
      "s1": { folderId: "folder-a" },
    }));

    // s1은 존재, s2는 존재하지 않음
    store.moveSessionsToFolder(["s1", "nonexistent"], "folder-b");

    expect(useDashboardStore.getState().catalog!.sessions["s1"].folderId).toBe("folder-b");
    expect(useDashboardStore.getState().catalog!.sessions["nonexistent"]).toBeUndefined();
  });
});
