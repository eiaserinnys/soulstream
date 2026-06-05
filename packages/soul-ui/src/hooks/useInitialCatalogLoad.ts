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

import { useEffect } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { SYSTEM_FOLDERS } from "../shared/constants";

export function useInitialCatalogLoad(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();

    fetch("/api/folders", { signal: controller.signal })
      .then((r) => {
        if (r.ok) return r.json();
        throw new Error("folders fetch failed");
      })
      .then((data) => {
        if (!data?.folders) return;
        const store = useDashboardStore.getState();
        const catalog = { folders: data.folders, sessions: data.sessions ?? {} };
        store.setCatalog(catalog);

        if (
          store.selectedFolderId === null &&
          !store.activeSessionKey &&
          store.viewMode === "folder"
        ) {
          const claudeFolder = catalog.folders.find(
            (f: { name: string }) => f.name === SYSTEM_FOLDERS.claude,
          );
          const defaultFolderId =
            claudeFolder?.id ?? catalog.folders[0]?.id ?? null;
          if (defaultFolderId) {
            useDashboardStore.getState().selectFolder(defaultFolderId);
          }
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => {
      controller.abort();
    };
  }, [enabled]);
}
