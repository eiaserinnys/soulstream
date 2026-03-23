/**
 * 폴더 CRUD 낙관적 업데이트 — soul-stream /api/folders 사용.
 */

import { useDashboardStore } from "@seosoyoung/soul-ui";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

/**
 * 폴더 생성 (API-first).
 * 임시 ID 없이 API 성공 후 실제 ID로 store에 추가한다.
 */
export async function createFolder(name: string): Promise<void> {
  const { addFolder } = useDashboardStore.getState();
  try {
    const res = await fetch("/api/folders", {
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
 * 폴더 이름 변경 낙관적 업데이트.
 */
export async function renameFolderOptimistic(
  folderId: string,
  name: string,
): Promise<void> {
  const { updateFolderName, catalog } = useDashboardStore.getState();
  const prevName = catalog?.folders.find((f) => f.id === folderId)?.name;

  updateFolderName(folderId, name);

  try {
    const res = await fetch(`/api/folders/${folderId}`, {
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
 */
export async function deleteFolderOptimistic(folderId: string): Promise<void> {
  const {
    removeFolder,
    addFolder,
    moveSessionsToFolder,
    selectFolder,
    catalog,
    selectedFolderId,
  } = useDashboardStore.getState();

  const folder = catalog?.folders.find((f) => f.id === folderId);
  const affectedSessionIds = catalog
    ? Object.entries(catalog.sessions)
        .filter(([, a]) => a.folderId === folderId)
        .map(([id]) => id)
    : [];
  const prevSelectedFolderId = selectedFolderId;

  if (selectedFolderId === folderId) {
    const fallbackId =
      catalog?.folders.find((f) => f.id !== folderId)?.id ?? null;
    selectFolder(fallbackId);
  }

  removeFolder(folderId);

  try {
    const res = await fetch(`/api/folders/${folderId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete folder failed: ${res.status}`);
  } catch (err) {
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
