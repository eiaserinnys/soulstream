import { useCallback } from "react";
import {
  useDashboardStore,
  type CatalogFolder,
  type CatalogFolderReorderItem,
} from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  deleteFolderOptimistic,
  renameFolderOptimistic,
  reorderFoldersOptimistic,
} from "../lib/folder-operations";
import {
  deleteProjectFolder,
  renameProjectFolder,
  reorderProjectFolders,
} from "./project-folder-actions";
import { projectHasContents } from "./project-form-model";

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
    await deleteProjectFolder(folder, deleteFolderOptimistic, readFolders);
    if (selectedFolderId === folder.id) clearProject();
  }, [clearProject, selectedFolderId]);

  const onReorderProjects = useCallback((items: CatalogFolderReorderItem[]) => (
    reorderProjectFolders(items, reorderFoldersOptimistic, readFolders)
  ), []);

  const hasProjectContents = useCallback((folderId: string) => {
    const catalog = useDashboardStore.getState().catalog;
    return catalog ? projectHasContents(folderId, catalog) : false;
  }, []);

  return {
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    onReorderProjects,
    projectHasContents: hasProjectContents,
  };
}
