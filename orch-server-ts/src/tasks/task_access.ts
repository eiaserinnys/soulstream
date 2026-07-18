import {
  isBoardFolderAllowed,
  type BoardAccess,
} from "../board/board_access.js";
import type {
  TaskFolderRecord,
  TaskOverview,
} from "./task_route_types.js";

export function filterTaskOverviewForAccess(
  overview: TaskOverview,
  folders: readonly TaskFolderRecord[],
  access: Required<BoardAccess>,
): TaskOverview {
  if (!access.restricted) return overview;

  const allowed = (entry: unknown): entry is Record<string, unknown> => {
    if (!isRecord(entry)) return false;
    const folderId = stringOrNull(entry.folder_id);
    return isBoardFolderAllowed(access, folders, folderId);
  };

  return {
    my_turn_items: arrayValue(overview.my_turn_items).filter(allowed),
    tasks: arrayValue(overview.tasks)
      .filter(allowed)
      .map((group) => ({
        ...group,
        items: arrayValue(group.items).filter(allowed),
      })),
  };
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
