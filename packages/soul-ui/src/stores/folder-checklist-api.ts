import type { FolderSnapshot, SetChecklistItemStatusInput, SetFolderStatusInput } from "./folder-checklist-store";
import type { ChecklistMutation } from "./checklist-mutations";

export class FolderChecklistApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FolderChecklistApiError";
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as Record<string, unknown>;
    const detail = payload.detail as Record<string, unknown> | string | undefined;
    const error = typeof detail === "object" ? detail.error as Record<string, unknown> | undefined : undefined;
    const message = error?.message ?? (typeof detail === "string" ? detail : payload.message);
    if (typeof message === "string" && message.trim()) return message;
  } catch { /* The status remains useful when the body is not JSON. */ }
  return `폴더 요청 실패 (${response.status})`;
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new FolderChecklistApiError(await errorMessage(response), response.status);
  return response.json();
}

export async function fetchFolderSnapshot(folderId: string, signal?: AbortSignal): Promise<FolderSnapshot | null> {
  const response = await fetch(`/api/folders/${encodeURIComponent(folderId)}`, {
    credentials: "same-origin", signal, headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new FolderChecklistApiError(await errorMessage(response), response.status);
  return response.json() as Promise<FolderSnapshot>;
}

export async function postChecklistItemStatus(input: SetChecklistItemStatusInput): Promise<void> {
  await post(`/api/folders/${encodeURIComponent(input.folderId)}/checklist/items/${encodeURIComponent(input.itemId)}/status`, {
    status: input.status, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

export async function postFolderStatus(input: SetFolderStatusInput): Promise<void> {
  await post(`/api/folders/${encodeURIComponent(input.folderId)}/status`, {
    status: input.status, expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

export async function postChecklistMutation(input: ChecklistMutation): Promise<void> {
  const request = mutationRequest(input);
  await post(request.path, request.body);
}

function mutationRequest(input: ChecklistMutation): { path: string; body: Record<string, unknown> } {
  const base = `/api/folders/${encodeURIComponent(input.folderId)}/checklist`;
  const common = { idempotencyKey: input.idempotencyKey };
  const versioned = "expectedVersion" in input ? {
    ...common, expectedVersion: input.expectedVersion,
    ...(input.reason ? { reason: input.reason } : {}),
  } : common;
  switch (input.kind) {
    case "create_section":
      return { path: `${base}/sections`, body: {
        ...common, title: input.title,
        ...(input.afterSectionId ? { afterSectionId: input.afterSectionId } : {}),
        ...(input.beforeSectionId ? { beforeSectionId: input.beforeSectionId } : {}),
      } };
    case "update_section":
      return { path: `${base}/sections/${encodeURIComponent(input.sectionId)}`, body: { ...versioned, title: input.title } };
    case "move_section":
      return { path: `${base}/sections/${encodeURIComponent(input.sectionId)}/move`, body: {
        ...versioned,
        ...(input.afterSectionId ? { afterSectionId: input.afterSectionId } : {}),
        ...(input.beforeSectionId ? { beforeSectionId: input.beforeSectionId } : {}),
      } };
    case "archive_section":
      return { path: `${base}/sections/${encodeURIComponent(input.sectionId)}/archive`, body: versioned };
    case "create_item":
      return { path: `${base}/sections/${encodeURIComponent(input.sectionId)}/items`, body: {
        ...common, title: input.title, howTo: input.howTo ?? "",
        ...(input.afterItemId ? { afterItemId: input.afterItemId } : {}),
        ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
      } };
    case "update_item":
      return { path: `${base}/items/${encodeURIComponent(input.itemId)}`, body: {
        ...versioned,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.howTo === undefined ? {} : { howTo: input.howTo }),
      } };
    case "move_item":
      return { path: `${base}/items/${encodeURIComponent(input.itemId)}/move`, body: {
        ...versioned, sectionId: input.sectionId,
        ...(input.afterItemId ? { afterItemId: input.afterItemId } : {}),
        ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
      } };
    case "archive_item":
      return { path: `${base}/items/${encodeURIComponent(input.itemId)}/archive`, body: versioned };
  }
}
