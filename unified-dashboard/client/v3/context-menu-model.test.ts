import { describe, expect, it, vi } from "vitest";

import {
  buildDocumentContextMenuActions,
  buildProjectContextMenuActions,
  buildFolderContextMenuActions,
  buildFolderSessionExtraActions,
} from "./context-menu-model";

describe("v3 context menu model", () => {
  it("keeps the folder action set identical across planner and starred surfaces", () => {
    const actions = folderActions();

    const planner = buildFolderContextMenuActions({
      starred: true,
      completed: false,
      inToday: true,
    }, actions);
    const starredNavigation = buildFolderContextMenuActions({
      starred: true,
      completed: false,
      inToday: true,
    }, actions);

    expect(starredNavigation).toEqual(planner);
    expect(planner.map((action) => action.label)).toEqual([
      "폴더 열기",
      "폴더 ID 복사",
      "별표 해제",
      "다른 폴더로 이동",
      "완료 처리",
      "오늘에서 제외",
    ]);
    expect(planner[2]?.separatorBefore).toBe(true);
  });

  it("derives folder state labels and completion availability in one place", () => {
    const menu = buildFolderContextMenuActions({
      starred: false,
      completed: true,
      inToday: false,
    }, folderActions());

    expect(menu[2]?.label).toBe("별표 추가");
    expect(menu[3]?.label).toBe("다른 폴더로 이동");
    expect(menu[4]).toMatchObject({ label: "완료 처리", disabled: true });
    expect(menu[5]?.label).toBe("오늘에 추가");
    expect(buildFolderContextMenuActions({
      starred: false,
      completed: false,
      inToday: false,
    }, folderActions()).map((action) => action.label)).toContain("완료 처리");
  });

  it("offers the existing folder management actions on child cards", () => {
    const rename = vi.fn();
    const archive = vi.fn();
    const menu = buildFolderContextMenuActions({
      starred: false, completed: false, inToday: false,
    }, { ...folderActions(), rename, archive });

    expect(menu.slice(-2).map((action) => action.label)).toEqual([
      "이름 변경", "폴더 보관",
    ]);
    menu.at(-2)?.onSelect();
    menu.at(-1)?.onSelect();
    expect(rename).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
  });

  it("keeps document common actions while adding only meaningful mount actions", () => {
    const common = buildDocumentContextMenuActions({
      open: vi.fn(),
      copyId: vi.fn(),
    });
    const mounted = buildDocumentContextMenuActions({
      open: vi.fn(),
      copyId: vi.fn(),
      unmount: vi.fn(),
      promote: vi.fn(),
      canPromote: false,
    });

    expect(common.map((action) => action.label)).toEqual(["문서 열기", "페이지 ID 복사"]);
    expect(mounted.map((action) => action.label)).toEqual([
      "문서 열기",
      "페이지 ID 복사",
      "폴더에서 마운트 해제",
      "프로젝트로 승격",
    ]);
    expect(mounted[2]).toMatchObject({ separatorBefore: true, destructive: true });
    expect(mounted[3]?.disabled).toBe(true);
  });

  it("adds folder-board move and destructive delete without duplicating the common actions", () => {
    const menu = buildDocumentContextMenuActions({
      open: vi.fn(),
      copyId: vi.fn(),
      moveToFolder: vi.fn(),
      remove: vi.fn(),
    });

    expect(menu.map((action) => action.label)).toEqual([
      "문서 열기",
      "페이지 ID 복사",
      "다른 폴더로 이동",
      "문서 삭제",
    ]);
    expect(menu[2]).toMatchObject({ separatorBefore: true });
    expect(menu[2]?.destructive).toBeUndefined();
    expect(menu[3]).toMatchObject({ destructive: true });
  });

  it("owns folder session extension ordering", () => {
    expect(buildProjectContextMenuActions({
      open: vi.fn(),
      copyId: vi.fn(),
      createFolder: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
    }).map((action) => action.label)).toEqual([
      "폴더 열기",
      "폴더 ID 복사",
      "새 폴더",
      "폴더 설정",
      "폴더 보관",
    ]);

    expect(buildFolderSessionExtraActions({
      continueFromSession: vi.fn(),
      moveToFolder: vi.fn(),
    }).map((action) => action.label)).toEqual([
      "＋ 이어서 새 세션 (승계)",
      "다른 폴더로 이동",
    ]);
  });
});

function folderActions() {
  return {
    open: vi.fn(),
    copyId: vi.fn(),
    toggleStar: vi.fn(),
    moveToParent: vi.fn(),
    complete: vi.fn(),
    toggleToday: vi.fn(),
  };
}
