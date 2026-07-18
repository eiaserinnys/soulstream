import type { TaskSnapshot } from "./task_route_types.js";

export function snapshotTaskFolderId(snapshot: TaskSnapshot): string | null {
  return stringOrNull(recordOrNull(snapshot.task)?.folder_id);
}

export function resolveTaskActorSessionId(
  snapshot: TaskSnapshot,
): string | null {
  const task = recordOrNull(snapshot.task);
  for (const value of [
    task?.completed_session_id,
    task?.created_session_id,
  ]) {
    const sessionId = stringOrNull(value);
    if (sessionId !== null && sessionId.length > 0) return sessionId;
  }
  return null;
}

export function resolveItemActorSessionId(
  snapshot: TaskSnapshot,
  itemId: string,
): string | null {
  const item = snapshotItem(snapshot, itemId);
  if (item === undefined) return null;
  const section = snapshotSection(snapshot, item.section_id);
  const task = recordOrNull(snapshot.task);
  for (const value of [
    item.assignee_session_id,
    item.updated_session_id,
    item.created_session_id,
    section?.updated_session_id,
    section?.created_session_id,
    task?.created_session_id,
  ]) {
    const sessionId = stringOrNull(value);
    if (sessionId !== null && sessionId.length > 0) return sessionId;
  }
  return null;
}

export function resolveSectionActorSessionId(
  snapshot: TaskSnapshot,
  sectionId: string,
): string | null {
  const section = snapshotSection(snapshot, sectionId);
  if (section === undefined) return null;
  const task = recordOrNull(snapshot.task);
  for (const value of [
    section.assignee_session_id,
    section.updated_session_id,
    section.created_session_id,
    task?.created_session_id,
  ]) {
    const sessionId = stringOrNull(value);
    if (sessionId !== null && sessionId.length > 0) return sessionId;
  }
  return null;
}

export function snapshotItem(
  snapshot: TaskSnapshot,
  itemId: string,
): Record<string, unknown> | undefined {
  return arrayValue(snapshot.items).find((item) => item.id === itemId);
}

export function snapshotSection(
  snapshot: TaskSnapshot,
  sectionId: unknown,
): Record<string, unknown> | undefined {
  const id = stringOrNull(sectionId);
  if (id === null) return undefined;
  return arrayValue(snapshot.sections).find((section) => section.id === id);
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
