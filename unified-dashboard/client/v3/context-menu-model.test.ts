import { describe, expect, it, vi } from "vitest";

import {
  buildDocumentContextMenuActions,
  buildProjectContextMenuActions,
  buildTaskContextMenuActions,
  buildTaskSessionExtraActions,
} from "./context-menu-model";

describe("v3 context menu model", () => {
  it("keeps the task action set identical across planner and starred surfaces", () => {
    const actions = taskActions();

    const planner = buildTaskContextMenuActions({
      starred: true,
      completed: false,
      inToday: true,
    }, actions);
    const starredNavigation = buildTaskContextMenuActions({
      starred: true,
      completed: false,
      inToday: true,
    }, actions);

    expect(starredNavigation).toEqual(planner);
    expect(planner.map((action) => action.label)).toEqual([
      "업무 열기",
      "업무 페이지 ID 복사",
      "별표 해제",
      "다른 프로젝트로 이동",
      "완료 처리",
      "오늘 플래너에서 제거",
    ]);
    expect(planner[2]?.separatorBefore).toBe(true);
  });

  it("derives task state labels and completion availability in one place", () => {
    const menu = buildTaskContextMenuActions({
      starred: false,
      completed: true,
      inToday: false,
    }, taskActions());

    expect(menu[2]?.label).toBe("별표 추가");
    expect(menu[3]?.label).toBe("다른 프로젝트로 이동");
    expect(menu[4]).toMatchObject({ label: "완료 처리", disabled: true });
    expect(menu[5]?.label).toBe("오늘 플래너에 추가");
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
      "업무에서 마운트 해제",
      "프로젝트로 승격",
    ]);
    expect(mounted[2]).toMatchObject({ separatorBefore: true, destructive: true });
    expect(mounted[3]?.disabled).toBe(true);
  });

  it("owns project and task-bound session extension ordering", () => {
    expect(buildProjectContextMenuActions({
      open: vi.fn(),
      copyId: vi.fn(),
      createTask: vi.fn(),
      createProject: vi.fn(),
      createChildProject: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
    }).map((action) => action.label)).toEqual([
      "프로젝트 열기",
      "폴더 ID 복사",
      "새 업무",
      "새 프로젝트",
      "하위 프로젝트 만들기",
      "프로젝트 설정",
      "프로젝트 삭제",
    ]);

    expect(buildTaskSessionExtraActions({
      continueFromSession: vi.fn(),
      moveToTask: vi.fn(),
    }).map((action) => action.label)).toEqual([
      "＋ 이어서 새 세션 (승계)",
      "다른 업무로 이동",
    ]);
  });
});

function taskActions() {
  return {
    open: vi.fn(),
    copyId: vi.fn(),
    toggleStar: vi.fn(),
    moveToProject: vi.fn(),
    complete: vi.fn(),
    toggleToday: vi.fn(),
  };
}
