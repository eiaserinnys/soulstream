/**
 * createFolderOperations - 폴더 CRUD 낙관적 업데이트 팩토리
 *
 * CatalogApiConfig를 받아 폴더 생성/이름변경/삭제 함수를 반환한다.
 * API 경로와 삭제 시 fallback 로직이 호스트별로 다르므로 config로 파라미터화한다.
 *
 * 낙관적 업데이트 패턴:
 *   1. 로컬 store를 즉시 갱신
 *   2. API 호출
 *   3. API 실패 시 원래 상태로 롤백
 *
 * SSE `catalog_updated` 이벤트가 서버 정본으로 최종 덮어쓰므로,
 * 낙관적 업데이트는 UX 지연을 줄이기 위한 임시 상태이다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import type { CatalogApiConfig } from "./catalog-api-config";
import type { CatalogFolder } from "../shared/types";

export function createFolderOperations(config: CatalogApiConfig) {
  return {
    /**
     * 폴더 생성 (API-first).
     *
     * 임시 ID를 먼저 추가하면 SSE 도착 전에 사용자가 임시 ID 폴더를 조작할 위험이 있으므로,
     * API 성공 후 서버가 부여한 실제 ID로 store에 추가한다.
     */
    async createFolder(name: string): Promise<void> {
      const { addFolder } = useDashboardStore.getState();

      try {
        const res = await fetch(config.folderBasePath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`Create folder failed: ${res.status}`);

        const created: CatalogFolder = await res.json();
        addFolder(created);
      } catch (err) {
        console.error("Folder creation failed:", err);
      }
    },

    /**
     * 폴더 이름 변경 낙관적 업데이트.
     *
     * 로컬 name을 즉시 갱신 -> API -> 실패 시 원래 이름으로 롤백.
     */
    async renameFolderOptimistic(folderId: string, newName: string): Promise<void> {
      const { updateFolderName, catalog } = useDashboardStore.getState();
      const prevName = catalog?.folders.find((f) => f.id === folderId)?.name;

      updateFolderName(folderId, newName);

      try {
        const res = await fetch(`${config.folderBasePath}/${folderId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) throw new Error(`Rename folder failed: ${res.status}`);
      } catch (err) {
        if (prevName !== undefined) {
          updateFolderName(folderId, prevName);
        }
        console.error("Folder rename failed, rolled back:", err);
      }
    },

    /**
     * 폴더 삭제 낙관적 업데이트.
     *
     * 로컬에서 즉시 삭제 -> API -> 실패 시 폴더 + 세션 배정 복원.
     */
    async deleteFolderOptimistic(folderId: string): Promise<void> {
      const { removeFolder, addFolder, moveSessionsToFolder, selectFolder, catalog, selectedFolderId } =
        useDashboardStore.getState();

      // 롤백용 스냅샷
      const folder = catalog?.folders.find((f) => f.id === folderId);
      const affectedSessionIds = catalog
        ? Object.entries(catalog.sessions)
            .filter(([, a]) => a.folderId === folderId)
            .map(([id]) => id)
        : [];
      const prevSelectedFolderId = selectedFolderId;

      // 삭제 대상이 현재 선택 폴더이면 fallback 폴더로 전환
      if (selectedFolderId === folderId) {
        const folders = catalog?.folders ?? [];
        const fallbackId = config.deleteFallbackFolderId(folders, folderId);
        selectFolder(fallbackId);
      }

      // 낙관적 삭제 (removeFolder가 세션의 folderId도 null로 변경)
      removeFolder(folderId);

      try {
        const res = await fetch(`${config.folderBasePath}/${folderId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Delete folder failed: ${res.status}`);
      } catch (err) {
        // 롤백: 폴더 복원 + 세션 재배정 + 폴더 선택 복원
        if (folder) {
          addFolder(folder);
          if (affectedSessionIds.length > 0) {
            moveSessionsToFolder(affectedSessionIds, folderId);
          }
          selectFolder(prevSelectedFolderId);
        }
        console.error("Folder deletion failed, rolled back:", err);
      }
    },
  };
}
