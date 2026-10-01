import type { PlannerBlock, PlannerPage, PlannerFolder } from '../../api/plannerTypes';
import type { Folder } from '../../api/types';

/** Catalog and planner folders share one workspace row shape. */
export function folderWorkspaceSummary(folder: Folder, page: PlannerPage, blocks: PlannerBlock[] = []): PlannerFolder {
  return {
    page,
    blocks,
    folderId: folder.id,
    folderSummary: {
      id: folder.id,
      title: folder.name,
      status: folder.status ?? 'open',
      archived: folder.archived ?? false,
      version: folder.version ?? 1,
      itemCounts: {},
      itemTotal: 0,
      completedItemCount: 0,
      assignee: null,
    },
    status: folder.status === 'completed' ? 'completed' : 'open',
    assignee: '',
    contextCount: 0,
    progress: null,
    projectPageId: null,
    parentFolderId: folder.parentFolderId ?? null,
    sessions: [],
    sessionIds: [],

  };
}

export function folderPage(folder: Folder): PlannerPage {
  return {
    id: folder.projectPageId!,
    title: folder.name,
    dailyDate: null,
    version: 1,
    archived: false,
    metadata: {},
    createdAt: folder.createdAt ?? '',
    updatedAt: '',
  };
}
