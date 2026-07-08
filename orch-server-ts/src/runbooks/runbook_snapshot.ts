import type { RunbookSnapshot } from "./runbook_route_types.js";

export function snapshotRunbookFolderId(snapshot: RunbookSnapshot): string | null {
  return stringOrNull(recordOrNull(snapshot.runbook)?.folder_id);
}

export function resolveRunbookActorSessionId(
  snapshot: RunbookSnapshot,
): string | null {
  const runbook = recordOrNull(snapshot.runbook);
  for (const value of [
    runbook?.completed_session_id,
    runbook?.created_session_id,
  ]) {
    const sessionId = stringOrNull(value);
    if (sessionId !== null && sessionId.length > 0) return sessionId;
  }
  return null;
}

export function resolveItemActorSessionId(
  snapshot: RunbookSnapshot,
  itemId: string,
): string | null {
  const item = snapshotItem(snapshot, itemId);
  if (item === undefined) return null;
  const section = snapshotSection(snapshot, item.section_id);
  const runbook = recordOrNull(snapshot.runbook);
  for (const value of [
    item.assignee_session_id,
    item.updated_session_id,
    item.created_session_id,
    section?.updated_session_id,
    section?.created_session_id,
    runbook?.created_session_id,
  ]) {
    const sessionId = stringOrNull(value);
    if (sessionId !== null && sessionId.length > 0) return sessionId;
  }
  return null;
}

export function snapshotItem(
  snapshot: RunbookSnapshot,
  itemId: string,
): Record<string, unknown> | undefined {
  return arrayValue(snapshot.items).find((item) => item.id === itemId);
}

function snapshotSection(
  snapshot: RunbookSnapshot,
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
