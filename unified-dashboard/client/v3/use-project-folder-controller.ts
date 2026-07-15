import { useCallback, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import { createFolder } from "../lib/folder-operations";
import { resolveProjectFolderId } from "./planner-model";
import { resolveProjectPage } from "./project-page-actions";

export function useProjectFolderController() {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<PageDto | null>(null);

  const openFolder = useCallback(async (
    api: PageApiClient,
    folder: CatalogFolder,
    knownPages: readonly PageDto[],
    notify: (message: string) => void,
  ) => {
    setSelectedFolderId(folder.id);
    setSelectedProject(null);
    try {
      setSelectedProject(await resolveProjectPage(api, folder, knownPages));
    } catch (error) {
      notify(`프로젝트 페이지 연결 실패 · ${errorText(error)}`);
    }
  }, []);

  const openProjectPage = useCallback((
    pageId: string,
    knownPages: readonly PageDto[],
    folders: readonly CatalogFolder[],
  ) => {
    const page = knownPages.find((candidate) => candidate.id === pageId);
    if (!page) return;
    setSelectedProject(page);
    setSelectedFolderId(resolveProjectFolderId(page, folders));
  }, []);

  const clearProject = useCallback(() => {
    setSelectedProject(null);
    setSelectedFolderId(null);
  }, []);

  const createProject = useCallback(async (
    title: string,
    api: PageApiClient,
    knownPages: readonly PageDto[],
    notify: (message: string) => void,
  ) => {
    const folder = await createFolder(title);
    if (!folder) throw new Error("프로젝트 폴더를 생성하지 못했습니다");
    await openFolder(api, folder, knownPages, notify);
  }, [openFolder]);

  return {
    selectedFolderId,
    selectedProject,
    setSelectedFolderId,
    setSelectedProject,
    openFolder,
    openProjectPage,
    clearProject,
    createProject,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
