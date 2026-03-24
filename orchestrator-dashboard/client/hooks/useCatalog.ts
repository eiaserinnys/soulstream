/**
 * useCatalog — FolderTree 카탈로그 초기화 훅.
 *
 * Phase 2에서 구현된 BFF /api/catalog 엔드포인트를 사용하여
 * soul-ui dashboard-store의 CatalogState를 초기화한다.
 */

import { useEffect, useRef } from "react";
import { useDashboardStore, SYSTEM_FOLDERS } from "@seosoyoung/soul-ui";
import type { CatalogState } from "@seosoyoung/soul-ui";

export function useCatalog() {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function loadCatalog() {
      try {
        const response = await fetch("/api/catalog");
        if (!response.ok) return;
        if (!mountedRef.current) return;

        const { folders: rawFolders, sessions: rawSessions } = await response.json();

        if (!mountedRef.current) return;

        // CatalogState 조합
        const folders: CatalogState["folders"] = (rawFolders ?? []).map(
          (f: { id: string; name: string; parent_id?: string | null }) => ({
            id: f.id,
            name: f.name,
            parentId: f.parent_id ?? null,
          })
        );

        // sessions → CatalogAssignment 매핑
        // BFF 응답: { session_id, node_id, folder_id, status, created_at, updated_at }
        const sessions: CatalogState["sessions"] = {};
        for (const s of rawSessions ?? []) {
          sessions[s.session_id as string] = {
            sessionId: s.session_id as string,
            folderId: (s.folder_id as string | null) ?? null,
          };
        }

        const catalog: CatalogState = { folders, sessions };
        const store = useDashboardStore.getState();
        store.setCatalog(catalog);

        // selectedFolderId가 아직 없으면 기본 폴더 자동 선택
        if (store.selectedFolderId === null && !store.activeSessionKey) {
          const claudeFolder = folders.find((f) => f.name === SYSTEM_FOLDERS.claude);
          const defaultFolderId = claudeFolder?.id ?? folders[0]?.id ?? null;
          if (defaultFolderId) {
            useDashboardStore.getState().selectFolder(defaultFolderId);
          }
        }
      } catch (err) {
        console.error("[useCatalog] 카탈로그 로드 실패:", err);
      }
    }

    loadCatalog();

    return () => {
      mountedRef.current = false;
    };
  }, []);
}
