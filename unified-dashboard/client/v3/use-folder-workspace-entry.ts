import type { CatalogFolder } from "@seosoyoung/soul-ui";

import type { PlannerFolder, FolderPlannerData } from "./planner-data";
import { derivePlannerFolderStatus, folderContextCount } from "./planner-model";

export function useFolderWorkspaceFolder({ folder, aggregate, knownFolder }: {
  folder: CatalogFolder | null;
  aggregate: FolderPlannerData | null;
  knownFolder: PlannerFolder | null;
}): { folderId: string | null; folder: PlannerFolder | null; error: null } {
  if (!folder) return { folderId: null, folder: null, error: null };
  if (aggregate?.folder.id === folder.id) {
    const completed = aggregate.cards.filter((item) => item.status === "done").length;
    return {
      folderId: folder.id,
      folder: {
        page: aggregate.project,
        blocks: aggregate.blocks,
        stateVector: "",
        folderId: folder.id,
        status: derivePlannerFolderStatus({ folder: aggregate.folder, cards: aggregate.cards }),
        assignee: knownFolder?.assignee ?? "담당 미지정",
        contextCount: folderContextCount(aggregate.blocks),
        progress: aggregate.cards.length ? Math.round(100 * completed / aggregate.cards.length) : null,
        parentFolderId: aggregate.folder.parentFolderId ?? null,
        sessionIds: aggregate.sessions.items.map((session) => session.agentSessionId),
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
