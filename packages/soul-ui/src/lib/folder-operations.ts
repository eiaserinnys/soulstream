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
import type { CatalogFolder, CatalogFolderReorderItem, FolderSettings } from "../shared/types";
import { isSystemFolderId } from "../shared/constants";
import { toastManager } from "../components/ui/toast";

export interface FolderApiConfig {
  createUrl: string;
  updateUrl: (id: string) => string;
  archiveUrl: (id: string) => string;
  /** 폴더 순서 재정렬 API URL */
  reorderUrl: string;
  /**
   * 삭제 후 폴백 폴더 결정 로직:
   * - string: 해당 id의 폴더를 catalog에서 찾아 폴백
   * - undefined/null: 폴더 미선택(null) 유지
   */
  archiveFallbackFolderId?: string | null;
}

export interface FolderOperations {
  createFolder: (name: string, parentFolderId?: string | null) => Promise<CatalogFolder | void>;
  renameFolderOptimistic: (folderId: string, name: string) => Promise<void>;
  archiveFolder: (folderId: string) => Promise<void>;
  updateFolderSettingsOptimistic: (folderId: string, settings: FolderSettings) => Promise<void>;
  reorderFoldersOptimistic: (items: CatalogFolderReorderItem[]) => Promise<void>;
}

export function createFolderOperations(config: FolderApiConfig): FolderOperations {
  /**
   * 폴더 생성 (API 성공 후 로컬 반영).
   *
   * rename/delete와 달리 낙관적 업데이트가 아닌 API-first 방식이다.
   * 임시 ID를 먼저 추가하면 SSE 도착 전에 사용자가 임시 ID 폴더를 조작할 위험이 있으므로,
   * API 성공 후 서버가 부여한 실제 ID로 store에 추가한다.
   */
  async function createFolder(
    name: string,
    parentFolderId?: string | null,
  ): Promise<CatalogFolder | void> {
    const { addFolder } = useDashboardStore.getState();

    try {
      const body: { name: string; parentFolderId?: string | null; idempotencyKey: string } = {
        name,
        idempotencyKey: operationId(),
      };
      if (parentFolderId !== undefined) {
        body.parentFolderId = parentFolderId;
      }
      const res = await fetch(config.createUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Create folder failed: ${res.status}`);

      const result = await res.json() as { folder: CatalogFolder };
      const created = result.folder;
      addFolder(created);
      return created;
    } catch (err) {
      console.error("Folder creation failed:", err);
      return undefined;
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
    if (isSystemFolderId(folderId)) return;

    const { updateFolderName, catalog } = useDashboardStore.getState();
    const folder = catalog?.folders.find((f) => f.id === folderId);
    const prevName = folder?.name;

    updateFolderName(folderId, name);

    try {
      const res = await fetch(config.updateUrl(folderId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expectedVersion: folder?.version, idempotencyKey: operationId() }),
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
   * 폴더를 보관한다. 서버가 내용과 세션 소속을 유지한다.
   */
  async function archiveFolder(folderId: string): Promise<void> {
    if (isSystemFolderId(folderId)) return;
    const { catalog } = useDashboardStore.getState();
    const folder = catalog?.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error("보관할 폴더를 찾을 수 없습니다");
    const res = await fetch(config.archiveUrl(folderId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: folder.version, idempotencyKey: operationId() }),
    });
    if (!res.ok) throw new Error(`Archive folder failed: ${res.status}`);
    const result = await res.json() as { folder: CatalogFolder };
    const state = useDashboardStore.getState();
    if (state.catalog) state.setCatalog({
      ...state.catalog,
      folders: state.catalog.folders.map((candidate) => candidate.id === folderId ? result.folder : candidate),
    });
    if (state.selectedFolderId === folderId) {
      const fallback = config.archiveFallbackFolderId;
      state.selectFolder(fallback && fallback !== folderId ? fallback : null);
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
    const folder = catalog?.folders.find((f) => f.id === folderId);
    const prevSettings = folder?.settings;

    updateFolderSettings(folderId, settings);

    try {
      const res = await fetch(config.updateUrl(folderId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, expectedVersion: folder?.version, idempotencyKey: operationId() }),
      });
      if (!res.ok) throw new Error(`Update folder settings failed: ${res.status}`);
    } catch (err) {
      if (prevSettings !== undefined) {
        updateFolderSettings(folderId, prevSettings);
      }
      console.error("Folder settings update failed, rolled back:", err);
    }
  }

  /**
   * 폴더 순서 낙관적 업데이트.
   *
   * 로컬 store의 folders 순서를 즉시 갱신 → API → 실패 시 이전 순서로 롤백.
   * SSE `catalog_updated`가 서버 정본으로 최종 덮어쓴다.
   */
  async function reorderFoldersOptimistic(items: CatalogFolderReorderItem[]): Promise<void> {
    if (items.some((item) => isSystemFolderId(item.id))) return;

    const { reorderFolders, setCatalog, catalog } = useDashboardStore.getState();
    const prevCatalog = catalog;

    // 낙관적 갱신
    reorderFolders(items);

    try {
      const res = await fetch(config.reorderUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
      if (!res.ok) throw new Error(`Reorder folders failed: ${res.status}`);
    } catch (err) {
      if (prevCatalog) setCatalog(prevCatalog);
      toastManager.add({
        title: "Folder move failed",
        description: "The folder tree was restored to the server state.",
        type: "warning",
      });
      console.error("Folder reorder failed, rolled back:", err);
    }
  }

  return { createFolder, renameFolderOptimistic, archiveFolder, updateFolderSettingsOptimistic, reorderFoldersOptimistic };
}

function operationId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return globalThis.crypto.randomUUID();
}
