import { useCallback, useRef, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import { createFolder } from "../lib/folder-operations";
import { resolveProjectFolderId } from "./planner-model";
import { resolveProjectPage } from "./project-page-actions";

export type ProjectFolderResolution =
  | { status: "idle"; folderId: null; project: null; message: null }
  | { status: "loading"; folderId: string; project: null; message: null }
  | { status: "ready"; folderId: string | null; project: PageDto | null; message: null }
  | { status: "error"; folderId: string; project: null; message: string };

interface ResolutionInput {
  api: PageApiClient;
  folder: CatalogFolder;
  knownPages: readonly PageDto[];
  notify(message: string): void;
}

export function useProjectFolderController() {
  const [resolution, setResolution] = useState<ProjectFolderResolution>({
    status: "idle",
    folderId: null,
    project: null,
    message: null,
  });
  const requestGeneration = useRef(0);
  const retryInput = useRef<ResolutionInput | null>(null);

  const resolveFolder = useCallback(async (input: ResolutionInput) => {
    const generation = ++requestGeneration.current;
    setResolution({ status: "loading", folderId: input.folder.id, project: null, message: null });
    try {
      const project = await resolveProjectPage(input.api, input.folder, input.knownPages);
      if (generation === requestGeneration.current) {
        setResolution({ status: "ready", folderId: input.folder.id, project, message: null });
      }
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setResolution({
        status: "error",
        folderId: input.folder.id,
        project: null,
        message: errorText(error),
      });
      input.notify("프로젝트를 열지 못했습니다.");
    }
  }, []);

  const openFolder = useCallback(async (
    api: PageApiClient,
    folder: CatalogFolder,
    knownPages: readonly PageDto[],
    notify: (message: string) => void,
  ) => {
    const input = { api, folder, knownPages, notify } satisfies ResolutionInput;
    retryInput.current = input;
    await resolveFolder(input);
  }, [resolveFolder]);

  const retry = useCallback(async () => {
    if (retryInput.current) await resolveFolder(retryInput.current);
  }, [resolveFolder]);

  const openProjectPage = useCallback((
    pageId: string,
    knownPages: readonly PageDto[],
    folders: readonly CatalogFolder[],
  ) => {
    const page = knownPages.find((candidate) => candidate.id === pageId);
    if (!page) return;
    requestGeneration.current += 1;
    retryInput.current = null;
    setResolution({
      status: "ready",
      folderId: resolveProjectFolderId(page, folders),
      project: page,
      message: null,
    });
  }, []);

  const clearProject = useCallback(() => {
    requestGeneration.current += 1;
    retryInput.current = null;
    setResolution({ status: "idle", folderId: null, project: null, message: null });
  }, []);

  const setSelectedFolderId = useCallback((folderId: string | null) => {
    requestGeneration.current += 1;
    retryInput.current = null;
    setResolution(folderId
      ? { status: "ready", folderId, project: null, message: null }
      : { status: "idle", folderId: null, project: null, message: null });
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
    resolution,
    selectedFolderId: resolution.folderId,
    selectedProject: resolution.status === "ready" ? resolution.project : null,
    setSelectedFolderId,
    openFolder,
    retry,
    openProjectPage,
    clearProject,
    createProject,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
