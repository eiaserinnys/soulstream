import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { useCallback, useState } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { loadStarredPlannerFolder, type PlannerFolder, type StarredPlannerFolder } from "./planner-data";
import type { FolderParentMoveDialogProps } from "./FolderParentMoveDialog";
import type { FolderParentTarget } from "./folder-parent-move";

export function useFolderParentMoveController({
  api,
  folders,
  moveFolder,
  notify,
}: {
  api: PageApiClient;
  folders: readonly CatalogFolder[];
  moveFolder(task: PlannerFolder, target: FolderParentTarget): Promise<void>;
  notify(message: string): void;
}) {
  const { t } = useTranslation();
  const [task, setFolder] = useState<PlannerFolder | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openFolder = useCallback((next: PlannerFolder) => {
    setFolder(next);
    setError(null);
  }, []);
  const openPage = useCallback(async (task: StarredPlannerFolder) => {
    try {
      openFolder(await loadStarredPlannerFolder(api, task, folders));
    } catch (cause) {
      notify(t("folders.errors.folderRead", { detail: folderErrorText(t, cause) }));
    }
  }, [t, api, folders, notify, openFolder]);
  const currentFolderId = task?.parentFolderId ?? null;
  const close = useCallback(() => {
    if (!pending) setFolder(null);
  }, [pending]);
  const move = useCallback((target: FolderParentTarget) => {
    if (!task || pending) return;
    setPending(true);
    setError(null);
    void moveFolder(task, target).then(() => {
      setFolder(null);
    }).catch((cause: unknown) => {
      setError(t("folders.errors.folderMove", { detail: folderErrorText(t, cause) }));
    }).finally(() => {
      setPending(false);
    });
  }, [t, moveFolder, pending, task]);
  const dialogProps: FolderParentMoveDialogProps = {
    task,
    currentFolderId,
    folders,
    pending,
    error,
    onMove: move,
    onClose: close,
  };
  return { openFolder, openPage, dialogProps };
}
