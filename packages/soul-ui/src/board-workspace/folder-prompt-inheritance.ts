import type { CatalogFolder } from "../shared/types";
import { getFolderBreadcrumbs } from "./board-workspace-helpers";

export interface InheritedFolderPrompt {
  folderId: string;
  folderName: string;
  prompt: string;
}

function promptValue(folder: CatalogFolder): string | null {
  const value = folder.settings?.folderPrompt;
  if (typeof value !== "string") return null;
  return value.trim() ? value : null;
}

export function getInheritedFolderPrompts(
  folders: readonly CatalogFolder[],
  folderId: string,
): InheritedFolderPrompt[] {
  return getFolderBreadcrumbs(folders, folderId)
    .slice(0, -1)
    .flatMap((folder) => {
      const prompt = promptValue(folder);
      return prompt
        ? [{ folderId: folder.id, folderName: folder.name, prompt }]
        : [];
    });
}
