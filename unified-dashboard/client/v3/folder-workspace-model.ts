import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";
import type { PlannerFolder } from "./planner-data";

export function plannerEntryForFolder(
  folder: CatalogFolder,
  page: PageDto,
  parentFolderId: string | null,
): PlannerFolder {
  return {
    page,
    blocks: [],
    stateVector: "",
    folderId: folder.id,
    status: folder.status === "completed" ? "completed" : "open",
    assignee: "담당 미지정",
    contextCount: 0,
    progress: null,
    parentFolderId: parentFolderId,
    sessionIds: [],
    mountedDocuments: [],
  };
}
