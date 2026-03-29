/**
 * 폴더 CRUD 낙관적 업데이트 팩토리
 *
 * API 경로를 config 객체로 주입받아, soul-dashboard와 orchestrator-dashboard
 * 모두에서 사용할 수 있는 폴더 조작 함수를 생성합니다.
 *
 * 패턴:
 *   1. 로컬 store를 즉시 갱신 (낙관적)
 *   2. API 호출
 *   3. API 실패 시 원래 상태로 롤백
 *
 * SSE `catalog_updated` 이벤트가 서버 정본으로 최종 덮어쓰므로,
 * 낙관적 업데이트는 UX 지연을 줄이기 위한 임시 상태이다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import type { CatalogFolder, FolderSettings } from "../shared/types";

export interface FolderApiConfig {
  createUrl: string;
  updateUrl: (id: string) => string;
  deleteUrl: (id: string) => string;
  /**
   * 삭제 후 폴백 폴더 결정 로직:
   * - string: 해당 이름의 폴더를 catalog에서 찾아 폴백 (soul-dashboard: SYSTEM_FOLDERS.claude)
   * - undefined: 삭제 대상이 아닌 첫 번째 폴더로 폴백 (orchestrator 방식)
   */
  deleteFallbackFolderName?: string;
}

export interface FolderOperations {
  createFolder: (name: string) => Promise<void>;
  renameFolderOptimistic: (folderId: string, name: string) => Promise<void>;
  deleteFolderOptimistic: (folderId: string) => Promise<void>;
  updateFolderSettingsOptimistic: (folderId: string, settings: FolderSettings) => Promise<void>;
}

export function createFolderOperations(config: FolderApiConfig): FolderOperations {
  /**
   * 폴더 생성 (API 성공 후 로컬 반영).
   *
   * rename/delete와 달리 낙관적 업데이트가 아닌 API-first 방식이다.
   * 임시 ID를 먼저 추가하면 SSE 도착 전에 사용자가 임시 ID 폴더를 조작할 위험이 있으므로,
   * API 성공 후 서버가 부여한 실제 ID로 store에 추가한다.
   */
  async function createFolder(name: string): Promise<void> {
    const { addFolder } = useDashboardStore.getState();

    try {
      const res = await fetch(config.createUrl, {
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
  }

  /**
   * 폴더 리네임 낙관적 업데이트.
   *
   * 로컬 name을 즉시 갱신 → API → 실패 시 원래 이름으로 롤백.
   */
  async function renameFolderOptimistic(
    folderId: string,
    name: string,
  ): Promise<void> {
    const { updateFolderName, catalog } = useDashboardStore.getState();
    const prevName = catalog?.folders.find((f) => f.id === folderId)?.name;

    updateFolderName(folderId, name);

    try {
      const res = await fetch(config.updateUrl(folderId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`Rename folder failed: ${res.status}`);
    } catch (err) {
      if (prevName !== undefined) {
        updateFolderName(folderId, prevName);
      }
      console.error("Folder rename failed, rolled back:", err);
    }
  }

  /**
   * 폴더 삭제 낙관적 업데이트.
   *
   * 로컬에서 즉시 삭제 → API → 실패 시 폴더 + 세션 배정 복원.
   */
  async function deleteFolderOptimistic(folderId: string): Promise<void> {
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

    // 삭제 대상이 현재 선택 폴더이면 폴백 폴더로 전환
    if (selectedFolderId === folderId) {
      let fallbackId: string | null = null;

      if (config.deleteFallbackFolderName) {
        // name 기반 탐색 (soul-dashboard: SYSTEM_FOLDERS.claude)
        const namedFolder = catalog?.folders.find(
          (f) => f.name === config.deleteFallbackFolderName && f.id !== folderId,
        );
        fallbackId = namedFolder?.id ?? catalog?.folders.find((f) => f.id !== folderId)?.id ?? null;
      } else {
        // 인덱스 기반 폴백 (orchestrator 방식)
        fallbackId = catalog?.folders.find((f) => f.id !== folderId)?.id ?? null;
      }

      selectFolder(fallbackId);
    }

    // 낙관적 삭제 (removeFolder가 세션의 folderId도 null로 변경)
    removeFolder(folderId);

    try {
      const res = await fetch(config.deleteUrl(folderId), {
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
  }

  /**
   * 폴더 설정 낙관적 업데이트.
   *
   * 로컬 settings를 즉시 갱신 → API → 실패 시 원래 settings로 롤백.
   */
  async function updateFolderSettingsOptimistic(
    folderId: string,
    settings: FolderSettings,
  ): Promise<void> {
    const { updateFolderSettings, catalog } = useDashboardStore.getState();
    const prevSettings = catalog?.folders.find((f) => f.id === folderId)?.settings;

    updateFolderSettings(folderId, settings);

    try {
      const res = await fetch(config.updateUrl(folderId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) throw new Error(`Update folder settings failed: ${res.status}`);
    } catch (err) {
      updateFolderSettings(folderId, prevSettings);
      console.error("Folder settings update failed, rolled back:", err);
    }
  }

  return { createFolder, renameFolderOptimistic, deleteFolderOptimistic, updateFolderSettingsOptimistic };
}
