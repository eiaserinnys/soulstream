import {
  useDashboardStore,
  type CatalogFolder,
  type CatalogState,
} from "@seosoyoung/soul-ui";
import { useEffect, useMemo, useState } from "react";

type CatalogBoardItem = NonNullable<CatalogState["boardItems"]>[number];

export type LegacyBoardItemsLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "authentication"
  | "forbidden"
  | "error";

export interface LegacyBoardItemsLoadState {
  status: LegacyBoardItemsLoadStatus;
  message: string | null;
}

export function boardItemsFailureKind(status: number): Extract<
  LegacyBoardItemsLoadStatus,
  "authentication" | "forbidden" | "error"
> {
  if (status === 401) return "authentication";
  if (status === 403) return "forbidden";
  return "error";
}

export function collectLegacyFolderIds(
  folders: readonly CatalogFolder[],
  rootFolderId: string,
): readonly string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const append = (folderId: string) => {
    if (visited.has(folderId)) return;
    visited.add(folderId);
    result.push(folderId);
    const children = folders
      .filter((folder) => folder.parentFolderId === folderId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
    for (const child of children) append(child.id);
  };
  append(rootFolderId);
  return result;
}

export function useV2LegacyBoardItems({
  folderId,
  folders,
  enabled,
}: {
  folderId: string | null;
  folders: readonly CatalogFolder[];
  enabled: boolean;
}): LegacyBoardItemsLoadState {
  const setBoardItemsForFolder = useDashboardStore((state) => state.setBoardItemsForFolder);
  const folderIds = useMemo(
    () => folderId ? collectLegacyFolderIds(folders, folderId) : [],
    [folderId, folders],
  );
  const folderKey = folderIds.join("\u0000");
  const [state, setState] = useState<LegacyBoardItemsLoadState>({
    status: enabled && folderId ? "loading" : "idle",
    message: null,
  });

  useEffect(() => {
    if (!enabled || !folderId) {
      setState({ status: "idle", message: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading", message: null });
    void Promise.all(folderIds.map(async (currentFolderId) => {
      const response = await fetch(`/api/board-items?folder_id=${encodeURIComponent(currentFolderId)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new BoardItemsLoadError(response.status);
      const data = await response.json() as { boardItems?: CatalogBoardItem[] };
      if (!Array.isArray(data.boardItems)) throw new BoardItemsLoadError(0);
      return { folderId: currentFolderId, boardItems: data.boardItems };
    })).then((results) => {
      if (controller.signal.aborted) return;
      for (const result of results) {
        setBoardItemsForFolder(result.folderId, result.boardItems);
      }
      setState({ status: "ready", message: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const kind = boardItemsFailureKind(error instanceof BoardItemsLoadError ? error.status : 0);
      setState({
        status: kind,
        message: kind === "authentication"
          ? "Sign in again to load legacy board items."
          : kind === "forbidden"
            ? "You do not have access to the legacy board items in this folder."
            : "Legacy board items could not be loaded.",
      });
    });
    return () => controller.abort();
  }, [enabled, folderId, folderKey, setBoardItemsForFolder]);

  return state;
}

class BoardItemsLoadError extends Error {
  constructor(readonly status: number) {
    super(`board items fetch failed: HTTP ${status}`);
  }
}
