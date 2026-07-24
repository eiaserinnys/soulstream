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
