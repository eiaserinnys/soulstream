import type { DialogueId } from "./dialogues-inventory";

/** Shape groups, preserving each live variant once. */
export const webDialogueGroups: { id: string; title: string; ids: DialogueId[] }[] = [
  { id: "create", title: "생성", ids: ["project-create", "folder-create", "card-create", "new-session", "succession", "user-create"] },
  { id: "rename", title: "이름 변경", ids: ["session-rename", "rename-markdown", "rename-folder", "rename-frame"] },
  { id: "move", title: "이동과 선택", ids: ["parent-move", "session-move", "document-move", "board-move-session", "board-move-markdown", "board-move-asset", "board-move-custom", "search"] },
  { id: "delete", title: "삭제와 확인", ids: ["archive-nav", "archive-detail", "archive-board", "session-delete", "sessions-delete", "document-delete", "continue-error"] },
  { id: "edit", title: "설정과 편집", ids: ["project-edit", "folder-settings", "settings", "user-edit", "ritual", "connection-planned", "connection-disconnected", "connection-checking", "connection-recovering", "connection-new-version", "persistent-settings-window", "persistent-settings-window-saving", "persistent-settings-window-failure"] },
  { id: "context", title: "컨텍스트", ids: ["atom-add", "atom-edit", "defaults-add", "defaults-edit"] },
  { id: "expand", title: "확대", ids: ["card-image", "file-image", "card-detail", "card-board", "document-overlay"] },
  { id: "mobile", title: "모바일 메뉴", ids: ["v3-sheet", "folder-sheet", "session-sheet"] },
  { id: "native", title: "기본 확인창", ids: ["confirm-user", "confirm-recurring", "confirm-persistent-session-release"] },
];
