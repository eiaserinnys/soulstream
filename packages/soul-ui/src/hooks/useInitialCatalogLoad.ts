/**
 * useInitialCatalogLoad - `/api/folders`에서 최초 catalog 골격을 가져와
 * dashboard store에 주입하고, 적절한 기본 폴더를 선택한다.
 *
 * 책임:
 * - 최초 마운트 시 /api/folders fetch
 * - 카탈로그 설정 (store.setCatalog)
 * - 사용자가 아직 아무 것도 선택하지 않았고 피드 뷰가 아닐 때 기본 폴더 선택
 *
 * 이 훅은 useSessionListProvider에서 분리된 사이드 이펙트다.
 */

import { useEffect, useState } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { DEFAULT_FOLDER_ID } from "../shared/constants";

interface FolderIdentity {
  id: string;
  [key: string]: unknown;
}

export type CatalogLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "authentication"
  | "forbidden"
  | "error";

export interface CatalogLoadState {
  status: CatalogLoadStatus;
  message: string | null;
}

export function catalogLoadFailureKind(status: number): Extract<
  CatalogLoadStatus,
  "authentication" | "forbidden" | "error"
> {
  if (status === 401) return "authentication";
  if (status === 403) return "forbidden";
  return "error";
}

export function resolveInitialDefaultFolderId(folders: readonly FolderIdentity[]): string | null {
  return folders.some((folder) => folder.id === DEFAULT_FOLDER_ID) ? DEFAULT_FOLDER_ID : null;
}

export function useInitialCatalogLoad(enabled: boolean): CatalogLoadState {
  const [loadState, setLoadState] = useState<CatalogLoadState>(() => ({
    status: enabled ? "loading" : "idle",
    message: null,
  }));

  useEffect(() => {
    if (!enabled) {
      setLoadState({ status: "idle", message: null });
      return;
    }

    const controller = new AbortController();
    setLoadState({ status: "loading", message: null });

    fetch("/api/folders", { signal: controller.signal })
      .then((r) => {
        if (r.ok) return r.json();
        const error = new Error(`folders fetch failed: HTTP ${r.status}`);
        Object.assign(error, { status: r.status });
        throw error;
      })
      .then((data) => {
        if (!data?.folders) {
          setLoadState({ status: "error", message: "Folder data is invalid." });
          return;
        }
        const store = useDashboardStore.getState();
        const catalog = { folders: data.folders, sessions: data.sessions ?? {} };
        store.setCatalog(catalog);
        setLoadState({ status: "ready", message: null });

        if (
          store.selectedFolderId === null &&
          !store.activeSessionKey &&
          store.viewMode === "folder"
        ) {
          const defaultFolderId = resolveInitialDefaultFolderId(catalog.folders);
          if (defaultFolderId) {
            useDashboardStore.getState().selectFolder(defaultFolderId);
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const status = typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status: unknown }).status)
          : 0;
        const kind = catalogLoadFailureKind(status);
        const message = kind === "authentication"
          ? "Sign in again to load legacy folders."
          : kind === "forbidden"
            ? "You do not have access to these legacy folders."
            : "Legacy folders could not be loaded.";
        setLoadState({ status: kind, message });
      });

    return () => {
      controller.abort();
    };
  }, [enabled]);

  return loadState;
}
