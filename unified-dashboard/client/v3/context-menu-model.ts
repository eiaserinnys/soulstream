export interface V3ContextMenuAction {
  label: string;
  onSelect(): void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export function buildFolderContextMenuActions(
  state: { starred: boolean; completed: boolean; inToday: boolean },
  actions: {
    open(): void | Promise<void>;
    copyId(): void | Promise<void>;
    toggleStar(): void | Promise<void>;
    moveToParent(): void | Promise<void>;
    complete(): void | Promise<void>;
    toggleToday(): void | Promise<void>;
    rename?(): void | Promise<void>;
    archive?(): void | Promise<void>;
  },
): V3ContextMenuAction[] {
  return [
    { label: "폴더 열기", onSelect: actions.open },
    { label: "폴더 ID 복사", onSelect: actions.copyId },
    {
      label: state.starred ? "별표 해제" : "별표 추가",
      onSelect: actions.toggleStar,
      separatorBefore: true,
    },
    {
      label: "다른 폴더로 이동",
      onSelect: actions.moveToParent,
    },
    {
      label: "완료 처리",
      onSelect: actions.complete,
      disabled: state.completed,
    },
    {
      label: state.inToday ? "오늘에서 제외" : "오늘에 추가",
      onSelect: actions.toggleToday,
    },
    ...(actions.rename && actions.archive ? [
      { label: "이름 변경", onSelect: actions.rename, separatorBefore: true },
      { label: "폴더 보관", onSelect: actions.archive, destructive: true },
    ] : []),
  ];
}

export function buildProjectContextMenuActions(actions: {
  open(): void | Promise<void>;
  copyId(): void | Promise<void>;
  createFolder(): void | Promise<void>;
  edit(): void | Promise<void>;
  remove(): void | Promise<void>;
}): V3ContextMenuAction[] {
  return [
    { label: "폴더 열기", onSelect: actions.open },
    { label: "폴더 ID 복사", onSelect: actions.copyId },
    { label: "새 폴더", onSelect: actions.createFolder, separatorBefore: true },
    { label: "폴더 설정", onSelect: actions.edit },
    {
      label: "폴더 보관",
      onSelect: actions.remove,
      separatorBefore: true,
      destructive: true,
    },
  ];
}

export function buildDocumentContextMenuActions(actions: {
  open(): void | Promise<void>;
  copyId(): void | Promise<void>;
  moveToFolder?(): void | Promise<void>;
  remove?(): void | Promise<void>;
  unmount?(): void | Promise<void>;
  promote?(): void | Promise<void>;
  canPromote?: boolean;
}): V3ContextMenuAction[] {
  const menu: V3ContextMenuAction[] = [
    { label: "문서 열기", onSelect: actions.open },
    { label: "페이지 ID 복사", onSelect: actions.copyId },
  ];
  if (actions.moveToFolder) {
    menu.push({
      label: "다른 폴더로 이동",
      onSelect: actions.moveToFolder,
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
      label: "폴더에서 마운트 해제",
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
