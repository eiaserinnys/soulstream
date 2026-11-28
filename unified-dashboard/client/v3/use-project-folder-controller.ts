import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { useCallback, useRef, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "../../../packages/page-model/src/types";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { createFolder } from "../lib/folder-operations";
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
  const { t } = useTranslation();
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
        message: folderErrorText(t, error),
      });
      input.notify(t("folders.errors.openFolder"));
    }
  }, [t]);

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

  const clearProject = useCallback(() => {
    requestGeneration.current += 1;
    retryInput.current = null;
    setResolution({ status: "idle", folderId: null, project: null, message: null });
  }, []);

  const patchProjectTitle = useCallback((folderId: string, title: string) => {
    setResolution((current) => current.status === "ready"
      && current.folderId === folderId
      && current.project
      ? { ...current, project: { ...current.project, title } }
      : current);
  }, []);

  const createProject = useCallback(async (
    title: string,
    api: PageApiClient,
    knownPages: readonly PageDto[],
    notify: (message: string) => void,
    parentFolderId: string | null = null,
  ) => {
    const folder = await createFolder(title, parentFolderId);
    if (!folder) throw new Error(t("folders.errors.createFolder"));
    await openFolder(api, folder, knownPages, notify);
    return folder;
  }, [t, openFolder]);

  return {
    resolution,
    selectedFolderId: resolution.folderId,
    selectedProject: resolution.status === "ready" ? resolution.project : null,
    patchProjectTitle,
    openFolder,
    retry,
    clearProject,
    createProject,
  };
}
