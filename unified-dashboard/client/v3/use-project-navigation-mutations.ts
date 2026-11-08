import { useCallback } from "react";
import {
  useDashboardStore,
  type CatalogFolder,
  type CatalogFolderReorderItem,
} from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  archiveFolder,
  renameFolderOptimistic,
  reorderFoldersOptimistic,
} from "../lib/folder-operations";
import {
  archiveProjectFolder,
  renameProjectFolder,
  reorderProjectFolders,
} from "./project-folder-actions";
import { projectHasContents } from "./project-form-model";
import { fetchFolderBoardItems } from "./folder-inline-board-api";
import { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";

const readFolders = () => useDashboardStore.getState().catalog?.folders ?? [];

export function useProjectNavigationMutations({
  api,
  knownPages,
  notify,
  selectedFolderId,
  createProject,
  patchProjectTitle,
  clearProject,
}: {
  api: PageApiClient;
  knownPages: readonly PageDto[];
  notify(message: string): void;
  selectedFolderId: string | null;
  createProject(
    title: string,
    api: PageApiClient,
    knownPages: readonly PageDto[],
    notify: (message: string) => void,
    parentFolderId?: string | null,
  ): Promise<CatalogFolder>;
  patchProjectTitle(folderId: string, title: string): void;
  clearProject(): void;
}) {
  const onCreateProject = useCallback((title: string, parentFolderId: string | null) => (
    createProject(title, api, knownPages, notify, parentFolderId)
  ), [api, createProject, knownPages, notify]);

  const onRenameProject = useCallback(async (folder: CatalogFolder, title: string) => {
    await renameProjectFolder(folder, title, renameFolderOptimistic, readFolders);
    patchProjectTitle(folder.id, title);
  }, [patchProjectTitle]);

  const onDeleteProject = useCallback(async (folder: CatalogFolder) => {
    await archiveProjectFolder(folder, archiveFolder, readFolders);
    if (selectedFolderId === folder.id) clearProject();
  }, [clearProject, selectedFolderId]);

  const onReorderProjects = useCallback((items: CatalogFolderReorderItem[]) => (
    reorderProjectFolders(items, reorderFoldersOptimistic, readFolders)
  ), []);

  const hasProjectContents = useCallback(async (folderId: string): Promise<boolean> => {
    const catalog = useDashboardStore.getState().catalog;
    const folders = catalog?.folders ?? [];
    const sessions = catalog?.sessions ?? {};
    if (projectHasContents(folderId, { folders, sessions, hasCards: false, hasDocuments: false })) {
      return true;
    }
    const [cards, items] = await Promise.all([
      cardRequest<{ cards: CardRow[] }>(
        `/api/cards?${new URLSearchParams({ includeCompleted: "true", folderId })}`,
      ),
      fetchFolderBoardItems(folderId),
    ]);
    return projectHasContents(folderId, {
      folders,
      sessions,
      hasCards: cards.cards.length > 0,
      hasDocuments: items.some((item) => item.itemType === "markdown"),
      hasResources: items.some((item) => item.itemType !== "markdown"),
    });
  }, []);

  return {
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    onReorderProjects,
    projectHasContents: hasProjectContents,
  };
}
