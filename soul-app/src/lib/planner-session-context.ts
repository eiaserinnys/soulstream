import type { PlannerFolder } from '../api/plannerTypes';

export const PLANNER_FOLDER_CONTEXT_KEY = 'planner-folder';

export interface SessionContextItem {
  key: string;
  label: string;
  content: unknown;
}

export function buildPlannerFolderContextItem(folder: PlannerFolder): SessionContextItem {
  return {
    key: PLANNER_FOLDER_CONTEXT_KEY,
    label: folder.page.title,
    content: { pageId: folder.page.id, folderId: folder.folderId },
  };
}
