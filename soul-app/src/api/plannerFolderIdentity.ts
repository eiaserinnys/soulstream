import type { PlannerFolder } from './plannerTypes';

export function requirePlannerFolderId(folder: Pick<PlannerFolder, 'folderId'>): string {
  if (typeof folder.folderId !== 'string' || folder.folderId.trim().length === 0) {
    throw new Error('폴더 ID가 없습니다.');
  }
  return folder.folderId.trim();
}
