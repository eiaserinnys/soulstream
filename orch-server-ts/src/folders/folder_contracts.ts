import type { ChecklistMutationResult, FolderRow, FolderSnapshot } from "../checklist/control_plane/checklist_types.js";

/** Row field names are converted only at the HTTP boundary; JSON content is opaque. */
export function serializeChecklistRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    value instanceof Date ? value.toISOString() : value,
  ]));
}

export function serializeFolder(row: FolderRow) {
  return serializeChecklistRow(row);
}

export function serializeFolderSnapshot(snapshot: FolderSnapshot, itemId?: string, outline = false) {
  const items = itemId ? snapshot.items.filter((item) => item.id === itemId) : snapshot.items;
  const sectionIds = new Set(items.map((item) => item.section_id));
  return {
    folder: serializeFolder(snapshot.folder),
    sections: snapshot.sections.filter((section) => !itemId || sectionIds.has(section.id)).map(serializeChecklistRow),
    items: items.map((item) => {
      const row = serializeChecklistRow(item);
      if (outline) delete row.howTo;
      return row;
    }),
  };
}

export function serializeChecklistMutation(result: ChecklistMutationResult) {
  const operation = serializeChecklistRow(result.operation);
  if (result.operation.target_kind === "folder") {
    return { folder: serializeFolder(result.snapshot.folder), operation, idempotent: result.idempotent ?? false };
  }
  const target = result.operation.target_kind === "section"
    ? result.snapshot.sections.find((section) => section.id === result.operation.target_id)
    : result.snapshot.items.find((item) => item.id === result.operation.target_id);
  return {
    folderId: result.snapshot.folder.id,
    [result.operation.target_kind]: target ? serializeChecklistRow(target) : null,
    operation,
    idempotent: result.idempotent ?? false,
  };
}
