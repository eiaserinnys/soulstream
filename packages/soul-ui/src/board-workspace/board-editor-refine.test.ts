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
    // 🔴24 유지: 메뉴는 여전히 document.body로 포털한다(backdrop-filter containing block 탈출).
    expect(menus).toContain(", document.body)");
    // 카드 메뉴 상태 자체는 컨테이너 종류로 게이트되지 않는다(폴더·업무 보드 공통).
    const view = read("./BoardWorkspaceView.tsx");
    expect(view).toContain("onTileContextMenu={handleTileContextMenu}");
  });
});

describe("🔴29 portaled context menus inherit theme foreground", () => {
  it("wraps the body portal in a text-foreground scope so labels aren't black on dark", () => {
    const menus = read("./BoardWorkspaceContextMenus.tsx");
    // document.body 포털은 앱 컨테이너의 color: var(--foreground) 상속을 잃으므로 래퍼로 재부여.
    expect(menus).toContain('createPortal(<div className="text-foreground">{menuTree}</div>, document.body)');
  });

  it("gives the independently-portaled folder menu an explicit foreground token", () => {
    const folderMenu = read("../components/FolderContextMenu.tsx");
    // FolderContextMenu는 자체 createPortal(document.body)이라 별도로 text-foreground를 준다.
    expect(folderMenu).toMatch(/createPortal\(/);
    expect(folderMenu).toMatch(/className="fixed[^"]*text-foreground/);
  });
});

describe("🔴23 task board layout persistence slice", () => {
  it("merges partial patches per task key and includes them in persist partialize", () => {
    const store = useDashboardStore.getState();
    store.setFolderBoardLayout("task-refine-A", { resourceWidth: 300, chatWidth: 420 });
    store.setFolderBoardLayout("task-refine-A", { overlayExpanded: true, overlayOffsetX: 24 });

    const layout = useDashboardStore.getState().folderBoardLayouts["task-refine-A"];
    expect(layout).toMatchObject({
      resourceWidth: 300,
      chatWidth: 420,
      overlayExpanded: true,
      overlayOffsetX: 24,
    });

    const persisted = useDashboardStore.persist
      .getOptions()
      .partialize?.(useDashboardStore.getState()) as { folderBoardLayouts?: Record<string, unknown> };
    expect(persisted).toHaveProperty("folderBoardLayouts");
    expect(persisted.folderBoardLayouts?.["task-refine-A"]).toMatchObject({ resourceWidth: 300 });
  });

  it("is a no-op when the patch does not change existing values", () => {
    const store = useDashboardStore.getState();
    store.setFolderBoardLayout("task-refine-B", { boardZoom: 1 });
    const before = useDashboardStore.getState().folderBoardLayouts;
    store.setFolderBoardLayout("task-refine-B", { boardZoom: 1 });
    // 동일 값 patch는 새 객체를 만들지 않아야 한다(불필요 persist/리렌더 방지).
    expect(useDashboardStore.getState().folderBoardLayouts).toBe(before);
  });
});

describe("markdown context menu edit delegation", () => {
  it("delegates document edits to the owning board surface without a global inspector fallback", () => {
    const menus = read("./BoardWorkspaceContextMenus.tsx");
    expect(menus).toContain("onRequestMarkdownEdit?.(markdownContextMenu.item.documentId)");
    expect(menus).not.toContain("requestBoardDocumentEdit");
    expect(menus).not.toContain("onEditBoardItem");
    const view = read("./BoardWorkspaceView.tsx");
    expect(view).toContain("onRequestMarkdownEdit={onRequestMarkdownEdit}");
    expect(view).not.toContain("onEditBoardItem");
  });
});
