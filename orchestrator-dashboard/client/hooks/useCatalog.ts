/**
 * useCatalog — FolderTree 카탈로그 초기화 훅.
 *
 * /api/folders (폴더 목록) + /api/sessions (세션-폴더 배정)을 조합하여
 * soul-ui dashboard-store의 CatalogState를 초기화한다.
 *
 * soul-dashboard의 /api/catalog 통합 엔드포인트와 달리,
 * soul-stream은 별도 엔드포인트를 제공하므로 두 번의 fetch로 합성한다.
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
        const [foldersRes, sessionsRes] = await Promise.all([
          fetch("/api/folders"),
          fetch("/api/sessions"),
        ]);

        if (!foldersRes.ok || !sessionsRes.ok) return;
        if (!mountedRef.current) return;

        const foldersData = await foldersRes.json();
        const sessionsData = await sessionsRes.json();

        if (!mountedRef.current) return;

        // CatalogState 조합
        const folders: CatalogState["folders"] = (foldersData.folders ?? []).map(
          (f: { id: string; name: string; parentId?: string | null }) => ({
            id: f.id,
            name: f.name,
            parentId: f.parentId ?? null,
          })
        );

        // sessions → CatalogAssignment 매핑
        const sessions: CatalogState["sessions"] = {};
        for (const s of sessionsData.sessions ?? []) {
          sessions[s.sessionId as string] = {
            sessionId: s.sessionId as string,
            folderId: (s.folderId as string | null) ?? null,
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
      } catch {
        // 카탈로그 로드 실패: FolderTree가 빈 상태로 렌더링됨
      }
    }

    loadCatalog();

    return () => {
      mountedRef.current = false;
    };
  }, []);
}
