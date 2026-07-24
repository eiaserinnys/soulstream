import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("🔴18 rounded CodeMirror editor container", () => {
  it("reuses the shared radius token and clips overflow so corners are visibly rounded", () => {
    const editor = read("../components/MarkdownCodeMirrorEditor.tsx");
    // 신규 토큰 없이 기존 radius 토큰을 재사용한다.
    expect(editor).toMatch(/borderRadius:\s*"var\(--radius-lg\)"/);
    expect(editor).toMatch(/overflow:\s*"hidden"/);
    // 이전 하드코딩 사각 반경은 제거한다.
    expect(editor).not.toContain('borderRadius: "0.375rem"');
  });
});

describe("🔴24 board card context menu portal", () => {
  it("portals the menus to document.body to escape backdrop-filter containing blocks", () => {
    const menus = read("./BoardWorkspaceContextMenus.tsx");
    expect(menus).toContain('import { createPortal } from "react-dom"');
    expect(menus).toContain("createPortal(menuTree, document.body)");
    // 카드 메뉴 상태 자체는 컨테이너 종류로 게이트되지 않는다(폴더·업무 보드 공통).
    const view = read("./BoardWorkspaceView.tsx");
    expect(view).toContain("onTileContextMenu={handleTileContextMenu}");
  });
});

describe("🔴23 task board layout persistence slice", () => {
  it("merges partial patches per task key and includes them in persist partialize", () => {
    const store = useDashboardStore.getState();
    store.setTaskBoardLayout("task-refine-A", { resourceWidth: 300, chatWidth: 420 });
    store.setTaskBoardLayout("task-refine-A", { overlayExpanded: true, overlayOffsetX: 24 });

    const layout = useDashboardStore.getState().taskBoardLayouts["task-refine-A"];
    expect(layout).toMatchObject({
      resourceWidth: 300,
      chatWidth: 420,
      overlayExpanded: true,
      overlayOffsetX: 24,
    });

    const persisted = useDashboardStore.persist
      .getOptions()
      .partialize?.(useDashboardStore.getState()) as { taskBoardLayouts?: Record<string, unknown> };
    expect(persisted).toHaveProperty("taskBoardLayouts");
    expect(persisted.taskBoardLayouts?.["task-refine-A"]).toMatchObject({ resourceWidth: 300 });
  });

  it("is a no-op when the patch does not change existing values", () => {
    const store = useDashboardStore.getState();
    store.setTaskBoardLayout("task-refine-B", { boardZoom: 1 });
    const before = useDashboardStore.getState().taskBoardLayouts;
    store.setTaskBoardLayout("task-refine-B", { boardZoom: 1 });
    // 동일 값 patch는 새 객체를 만들지 않아야 한다(불필요 persist/리렌더 방지).
    expect(useDashboardStore.getState().taskBoardLayouts).toBe(before);
  });
});

describe("🔴25 markdown edit opens the center overlay in edit mode", () => {
  it("requestBoardDocumentEdit sets active doc + pending edit; a normal open clears pending", () => {
    const store = useDashboardStore.getState();
    store.requestBoardDocumentEdit("doc-25");
    let s = useDashboardStore.getState();
    expect(s.activeBoardDocumentId).toBe("doc-25");
    expect(s.pendingBoardDocumentEditId).toBe("doc-25");

    // 일반 열기(카드/탭)는 편집 요청을 비운다 → 자동 편집 진입 없음.
    store.setActiveBoardDocument("doc-25");
    expect(useDashboardStore.getState().pendingBoardDocumentEditId).toBeNull();

    // 소비 clear.
    store.requestBoardDocumentEdit("doc-25");
    store.clearPendingBoardDocumentEdit();
    expect(useDashboardStore.getState().pendingBoardDocumentEditId).toBeNull();
  });

  it("markdown menu edits via requestBoardDocumentEdit; custom_view has no edit item", () => {
    const menus = read("./BoardWorkspaceContextMenus.tsx");
    // 마크다운 "편집"은 중앙 오버레이를 편집 모드로 연다.
    expect(menus).toContain("requestBoardDocumentEdit(markdownContextMenu.item.documentId)");
    // custom_view는 편집 항목/편집 위임 prop이 없다.
    expect(menus).not.toContain("requestBoardDocumentEdit(customViewContextMenu");
    expect(menus).not.toContain("onEditBoardItem");
    // 왼쪽 탭으로 여는 onOpenMarkdownDocument는 더 이상 "편집" 액션에 쓰이지 않는다.
    const view = read("./BoardWorkspaceView.tsx");
    expect(view).not.toContain("onEditBoardItem");
  });
});
