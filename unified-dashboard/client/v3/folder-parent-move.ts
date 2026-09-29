import type { CatalogFolder } from "@seosoyoung/soul-ui";
import { moveFolderToParent } from "./folder-workspace-api";
import type { PlannerFolder } from "./planner-data";

export interface FolderParentTarget { folderId: string }

export async function runOptimisticFolderMove(input: {
  folder: CatalogFolder;
  task: PlannerFolder;
  target: FolderParentTarget;
  project(task: PlannerFolder, targetFolderId: string | null): void;
}) {
  const { folder, task, target, project } = input;
  if (folder.parentFolderId === target.folderId) throw new Error("이미 이 폴더에 속해 있습니다");
  project(task, target.folderId);
  try {
    await moveFolderToParent(folder, target.folderId);
    return { targetFolderId: target.folderId };
  } catch (error) {
    project({ ...task, parentFolderId: target.folderId }, folder.parentFolderId ?? null);
    throw error;
  }
}
