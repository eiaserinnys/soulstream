import type { CatalogFolder } from "@seosoyoung/soul-ui";

export interface FolderMutationResult {
  folder: CatalogFolder;
  idempotent: boolean;
}

export async function moveFolderToParent(folder: CatalogFolder, parentFolderId: string): Promise<FolderMutationResult> {
  if (folder.version === undefined) throw new Error("폴더 버전을 찾을 수 없습니다.");
  const response = await fetch(`/api/folders/${encodeURIComponent(folder.id)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ parentFolderId, expectedVersion: folder.version, idempotencyKey: crypto.randomUUID() }),
  });
  if (!response.ok) throw new Error(`폴더 이동 실패 (${response.status})`);
  return response.json() as Promise<FolderMutationResult>;
}

export async function setFolderChecklistEnabled(folder: CatalogFolder, enabled: boolean): Promise<FolderMutationResult> {
  if (folder.version === undefined) throw new Error("폴더 버전을 찾을 수 없습니다.");
  return mutateFolder(folder, "checklist-enabled", {
    checklistEnabled: enabled,
    expectedVersion: folder.version,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function setFolderStatus(folder: CatalogFolder, status: "open" | "completed"): Promise<FolderMutationResult> {
  if (folder.version === undefined) throw new Error("폴더 버전을 찾을 수 없습니다.");
  return mutateFolder(folder, "status", {
    status,
    expectedVersion: folder.version,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function mutateFolder(folder: CatalogFolder, action: string, body: Record<string, unknown>): Promise<FolderMutationResult> {
  const response = await fetch(`/api/folders/${encodeURIComponent(folder.id)}/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`폴더 변경 실패 (${response.status})`);
  return await response.json() as FolderMutationResult;
}
