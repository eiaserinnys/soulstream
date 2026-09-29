import type {
  ChecklistAssigneeFields,
  ChecklistItemRow,
  ChecklistSectionRow,
  FolderOperationRow,
  FolderOperationTargetKind,
  FolderRow,
  FolderSnapshot,
} from "../../db/session_db_types.js";

export interface FolderMutationEnvelope {
  snapshot: FolderSnapshot;
  operation: FolderOperationRow | Record<string, unknown>;
  idempotent?: boolean;
}

export function formatFolderMutationResponse(
  result: FolderMutationEnvelope,
  targetKind: FolderOperationTargetKind,
  includeSnapshot: boolean,
): FolderMutationEnvelope | Record<string, unknown> {
  if (includeSnapshot) return result;
  const targetId = readTargetId(result.operation);
  const row = findTargetRow(result.snapshot, targetKind, targetId);
  return {
    operation: result.operation,
    target: { kind: targetKind, row },
    folder: folderHeader(result.snapshot.folder),
    ...(result.idempotent === undefined ? {} : { idempotent: result.idempotent }),
  };
}

export function formatFolderReadResponse(
  snapshot: FolderSnapshot | null,
  options: { view: "full" | "outline"; itemId?: string },
): FolderSnapshot | Record<string, unknown> | null {
  if (!snapshot) return null;
  if (options.itemId) {
    const item = snapshot.items.find((candidate) => candidate.id === options.itemId);
    if (!item) throw new Error(`checklist item not found: ${options.itemId}`);
    const section = snapshot.sections.find((candidate) => candidate.id === item.section_id);
    if (!section) throw new Error(`checklist section not found for item: ${options.itemId}`);
    return options.view === "outline"
      ? { folder: outlineFolder(snapshot.folder), section: outlineSection(section), item: outlineItem(item) }
      : { folder: snapshot.folder, section, item };
  }
  if (options.view === "full") return snapshot;
  return {
    folder: outlineFolder(snapshot.folder),
    sections: snapshot.sections.map((section) => ({
      ...outlineSection(section),
      items: snapshot.items.filter((item) => item.section_id === section.id).map(outlineItem),
    })),
  };
}

function readTargetId(operation: unknown): string {
  if (!operation || typeof operation !== "object") throw new Error("folder mutation operation is missing");
  const record = operation as Record<string, unknown>;
  const targetId = record.target_id ?? record.targetId;
  if (typeof targetId !== "string" || targetId.length === 0) throw new Error("folder mutation operation is missing target_id");
  return targetId;
}

function findTargetRow(snapshot: FolderSnapshot, targetKind: FolderOperationTargetKind, targetId: string): FolderRow | ChecklistSectionRow | ChecklistItemRow {
  if (targetKind === "folder") {
    if (snapshot.folder.id !== targetId) throw new Error(`folder mutation target not found: ${targetId}`);
    return snapshot.folder;
  }
  const rows = targetKind === "section" ? snapshot.sections : snapshot.items;
  const row = rows.find((candidate) => candidate.id === targetId);
  if (!row) throw new Error(`checklist ${targetKind} mutation target not found: ${targetId}`);
  return row;
}

function folderHeader(folder: FolderRow) {
  return { id: folder.id, version: folder.version, updated_at: folder.updated_at };
}

function outlineFolder(folder: FolderRow) {
  return { id: folder.id, name: folder.name, checklist_enabled: folder.checklist_enabled, status: folder.status, version: folder.version, updated_at: folder.updated_at };
}

function outlineSection(section: ChecklistSectionRow) {
  return { id: section.id, title: section.title, version: section.version, assignee: outlineAssignee(section) };
}

function outlineItem(item: ChecklistItemRow) {
  return { id: item.id, title: item.title, status: item.status, version: item.version, assignee: outlineAssignee(item) };
}

function outlineAssignee(fields: ChecklistAssigneeFields) {
  if (!fields.assignee_kind) return null;
  return {
    kind: fields.assignee_kind,
    ...(fields.assignee_agent_id ? { agent_id: fields.assignee_agent_id } : {}),
    ...(fields.assignee_session_id ? { session_id: fields.assignee_session_id } : {}),
    ...(fields.assignee_user_id ? { user_id: fields.assignee_user_id } : {}),
  };
}
