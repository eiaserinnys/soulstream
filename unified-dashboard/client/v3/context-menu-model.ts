import { todayPlannerMenuLabel } from "./today-task-state";

export interface V3ContextMenuAction {
  label: string;
  onSelect(): void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export interface V3SessionContextMenuExtraAction {
  label: string;
  onClick(): void | Promise<void>;
  disabled?: boolean;
  className?: string;
}

export function buildTaskContextMenuActions(
  state: { starred: boolean; completed: boolean; inToday: boolean },
  actions: {
    open(): void | Promise<void>;
    copyId(): void | Promise<void>;
    toggleStar(): void | Promise<void>;
    moveToProject(): void | Promise<void>;
    complete(): void | Promise<void>;
    toggleToday(): void | Promise<void>;
  },
): V3ContextMenuAction[] {
  return [
    { label: "업무 열기", onSelect: actions.open },
    { label: "업무 페이지 ID 복사", onSelect: actions.copyId },
    {
      label: state.starred ? "별표 해제" : "별표 추가",
      onSelect: actions.toggleStar,
      separatorBefore: true,
    },
    {
      label: "다른 프로젝트로 이동",
      onSelect: actions.moveToProject,
    },
    {
      label: "완료 처리",
      onSelect: actions.complete,
      disabled: state.completed,
    },
    {
      label: todayPlannerMenuLabel(state.inToday),
      onSelect: actions.toggleToday,
    },
  ];
}

export function buildProjectContextMenuActions(actions: {
  open(): void | Promise<void>;
  copyId(): void | Promise<void>;
  createTask(): void | Promise<void>;
  createProject(): void | Promise<void>;
  createChildProject(): void | Promise<void>;
  edit(): void | Promise<void>;
  remove(): void | Promise<void>;
}): V3ContextMenuAction[] {
  return [
    { label: "프로젝트 열기", onSelect: actions.open },
    { label: "폴더 ID 복사", onSelect: actions.copyId },
    { label: "새 업무", onSelect: actions.createTask, separatorBefore: true },
    { label: "새 프로젝트", onSelect: actions.createProject, separatorBefore: true },
    { label: "하위 프로젝트 만들기", onSelect: actions.createChildProject },
    { label: "프로젝트 설정", onSelect: actions.edit },
    {
      label: "프로젝트 삭제",
      onSelect: actions.remove,
      separatorBefore: true,
      destructive: true,
    },
  ];
}

export function buildDocumentContextMenuActions(actions: {
  open(): void | Promise<void>;
  copyId(): void | Promise<void>;
  moveToTask?(): void | Promise<void>;
  remove?(): void | Promise<void>;
  unmount?(): void | Promise<void>;
  promote?(): void | Promise<void>;
  canPromote?: boolean;
}): V3ContextMenuAction[] {
  const menu: V3ContextMenuAction[] = [
    { label: "문서 열기", onSelect: actions.open },
    { label: "페이지 ID 복사", onSelect: actions.copyId },
  ];
  if (actions.moveToTask) {
    menu.push({
      label: "다른 업무로 이동",
      onSelect: actions.moveToTask,
      separatorBefore: true,
    });
  }
  if (actions.remove) {
    menu.push({
      label: "문서 삭제",
      onSelect: actions.remove,
      destructive: true,
    });
  }
  if (actions.unmount) {
    menu.push({
      label: "업무에서 마운트 해제",
      onSelect: actions.unmount,
      separatorBefore: true,
      destructive: true,
    });
  }
  if (actions.promote) {
    menu.push({
      label: "프로젝트로 승격",
      onSelect: actions.promote,
      disabled: actions.canPromote === false,
    });
  }
  return menu;
}

export function buildTaskSessionExtraActions(actions: {
  continueFromSession(): void | Promise<void>;
  moveToTask(): void | Promise<void>;
}): V3SessionContextMenuExtraAction[] {
  return [
    { label: "＋ 이어서 새 세션 (승계)", onClick: actions.continueFromSession },
    { label: "다른 업무로 이동", onClick: actions.moveToTask },
  ];
}
