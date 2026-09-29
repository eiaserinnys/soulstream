import type { CatalogFolder } from "@seosoyoung/soul-ui";

import type { PlannerFolder, ProjectPlannerData } from "./planner-data";
import { derivePlannerFolderStatus, folderContextCount } from "./planner-model";

export function useFolderWorkspaceFolder({ folder, aggregate, knownFolder }: {
  folder: CatalogFolder | null;
  aggregate: ProjectPlannerData | null;
  knownFolder: PlannerFolder | null;
}): { folderId: string | null; folder: PlannerFolder | null; error: null } {
  if (!folder) return { folderId: null, folder: null, error: null };
  if (aggregate?.folder.id === folder.id) {
    const completed = aggregate.items.filter((item) => item.status === "completed").length;
    return {
      folderId: folder.id,
      folder: {
        page: aggregate.project,
        blocks: aggregate.blocks,
        stateVector: "",
        folderId: folder.id,
        status: derivePlannerFolderStatus({ folder: aggregate.folder, items: aggregate.items }),
        assignee: knownFolder?.assignee ?? "담당 미지정",
        contextCount: folderContextCount(aggregate.blocks),
        progress: aggregate.items.length ? Math.round(100 * completed / aggregate.items.length) : null,
        parentFolderId: aggregate.folder.parentFolderId ?? null,
        sessionIds: aggregate.sessions.items.map((session) => session.agentSessionId),
        mountedDocuments: [],
      },
      error: null,
    };
  }
  return {
    folderId: folder.id,
    folder: knownFolder?.folderId === folder.id ? knownFolder : null,
    error: null,
  };
}
