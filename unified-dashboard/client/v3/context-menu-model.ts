import { dictionaries } from "@soulstream/i18n";

type SessionTextKey = keyof typeof dictionaries.ko.sessions;
type Translate = (key: `sessions.${SessionTextKey}`) => string;

function koreanSessionText(key: Parameters<Translate>[0]): string {
  return dictionaries.ko.sessions[key.slice("sessions.".length) as SessionTextKey];
}

export interface V3ContextMenuAction {
  label: string;
  onSelect(): void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export function buildFolderContextMenuActions(
  state: { starred: boolean; completed: boolean },
  actions: {
    open(): void | Promise<void>;
    copyId(): void | Promise<void>;
    toggleStar(): void | Promise<void>;
    moveToParent(): void | Promise<void>;
    complete(): void | Promise<void>;
    rename?(): void | Promise<void>;
    archive?(): void | Promise<void>;
  },
  t: Translate = koreanSessionText,
): V3ContextMenuAction[] {
  return [
    { label: t("sessions.openFolder"), onSelect: actions.open },
    { label: t("sessions.copyFolderId"), onSelect: actions.copyId },
    {
      label: state.starred ? t("sessions.unstar") : t("sessions.star"),
      onSelect: actions.toggleStar,
      separatorBefore: true,
    },
    {
      label: t("sessions.moveToFolder"),
      onSelect: actions.moveToParent,
    },
    {
      label: t("sessions.markComplete"),
      onSelect: actions.complete,
      disabled: state.completed,
    },
    ...(actions.rename && actions.archive ? [
      { label: t("sessions.rename"), onSelect: actions.rename, separatorBefore: true },
      { label: t("sessions.archiveFolder"), onSelect: actions.archive, destructive: true },
    ] : []),
  ];
}

export function buildProjectContextMenuActions(actions: {
  open(): void | Promise<void>;
  copyId(): void | Promise<void>;
  createFolder(): void | Promise<void>;
  edit(): void | Promise<void>;
  remove(): void | Promise<void>;
}, t: Translate = koreanSessionText): V3ContextMenuAction[] {
  return [
    { label: t("sessions.openFolder"), onSelect: actions.open },
    { label: t("sessions.copyFolderId"), onSelect: actions.copyId },
    { label: t("sessions.newFolder"), onSelect: actions.createFolder, separatorBefore: true },
    { label: t("sessions.folderSettings"), onSelect: actions.edit },
    {
      label: t("sessions.archiveFolder"),
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
}, t: Translate = koreanSessionText): V3ContextMenuAction[] {
  const menu: V3ContextMenuAction[] = [
    { label: t("sessions.openDocument"), onSelect: actions.open },
    { label: t("sessions.copyPageId"), onSelect: actions.copyId },
  ];
  if (actions.moveToFolder) {
    menu.push({
      label: t("sessions.moveToFolder"),
      onSelect: actions.moveToFolder,
      separatorBefore: true,
    });
  }
  if (actions.remove) {
    menu.push({
      label: t("sessions.deleteDocument"),
      onSelect: actions.remove,
      destructive: true,
    });
  }
  if (actions.unmount) {
    menu.push({
      label: t("sessions.unmountDocument"),
      onSelect: actions.unmount,
      separatorBefore: true,
      destructive: true,
    });
  }
  if (actions.promote) {
    menu.push({
      label: t("sessions.promoteProject"),
      onSelect: actions.promote,
      disabled: actions.canPromote === false,
    });
  }
  return menu;
}
