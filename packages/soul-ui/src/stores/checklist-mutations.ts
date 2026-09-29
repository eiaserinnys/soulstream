import type {
  ChecklistItemRow,
  ChecklistSectionRow,
  FolderSnapshot,
} from "./folder-checklist-store";

interface MutationBase {
  folderId: string;
  idempotencyKey: string;
}

interface VersionedMutationBase extends MutationBase {
  expectedVersion: number;
  reason?: string | null;
}

export type ChecklistMutation =
  | (MutationBase & {
      kind: "create_section";
      sectionId: string;
      title: string;
      afterSectionId?: string | null;
      beforeSectionId?: string | null;
    })
  | (VersionedMutationBase & {
      kind: "update_section";
      sectionId: string;
      title: string;
    })
  | (VersionedMutationBase & {
      kind: "move_section";
      sectionId: string;
      afterSectionId?: string | null;
      beforeSectionId?: string | null;
    })
  | (VersionedMutationBase & {
      kind: "archive_section";
      sectionId: string;
    })
  | (MutationBase & {
      kind: "create_item";
      sectionId: string;
      itemId: string;
      title: string;
      howTo?: string;
      afterItemId?: string | null;
      beforeItemId?: string | null;
    })
  | (VersionedMutationBase & {
      kind: "update_item";
      itemId: string;
      title?: string;
      howTo?: string;
    })
  | (VersionedMutationBase & {
      kind: "move_item";
      itemId: string;
      sectionId: string;
      afterItemId?: string | null;
      beforeItemId?: string | null;
    })
  | (VersionedMutationBase & {
      kind: "archive_item";
      itemId: string;
    });

export function applyChecklistMutationOptimistically(
  snapshot: FolderSnapshot,
  mutation: ChecklistMutation,
  now = new Date().toISOString(),
): FolderSnapshot {
  switch (mutation.kind) {
    case "create_section": {
      const section = newSection(mutation, now);
      return {
        ...snapshot,
        sections: positionRows(
          insertAtBounds(
            orderedRows(snapshot.sections),
            section,
            mutation.afterSectionId,
            mutation.beforeSectionId,
          ),
        ),
      };
    }
    case "update_section":
      return {
        ...snapshot,
        sections: snapshot.sections.map((section) =>
          section.id === mutation.sectionId
            ? { ...section, title: mutation.title, version: section.version + 1, updatedAt: now }
            : section),
      };
    case "move_section": {
      const section = snapshot.sections.find((candidate) => candidate.id === mutation.sectionId);
      if (!section) return snapshot;
      const siblings = orderedRows(
        snapshot.sections.filter((candidate) => candidate.id !== mutation.sectionId),
      );
      return {
        ...snapshot,
        sections: positionRows(insertAtBounds(
          siblings,
          { ...section, version: section.version + 1, updatedAt: now },
          mutation.afterSectionId,
          mutation.beforeSectionId,
        )),
      };
    }
    case "archive_section":
      return {
        ...snapshot,
        sections: snapshot.sections.filter((section) => section.id !== mutation.sectionId),
        items: snapshot.items.filter((item) => item.sectionId !== mutation.sectionId),
      };
    case "create_item": {
      const created = newItem(mutation, now);
      const siblings = orderedRows(
        snapshot.items.filter((item) => item.sectionId === mutation.sectionId),
      );
      const positioned = positionRows(insertAtBounds(
        siblings,
        created,
        mutation.afterItemId,
        mutation.beforeItemId,
      ));
      return {
        ...snapshot,
        items: [
          ...snapshot.items.filter((item) => item.sectionId !== mutation.sectionId),
          ...positioned,
        ],
      };
    }
    case "update_item":
      return {
        ...snapshot,
        items: snapshot.items.map((item) =>
          item.id === mutation.itemId
            ? {
                ...item,
                ...(mutation.title === undefined ? {} : { title: mutation.title }),
                ...(mutation.howTo === undefined ? {} : { howTo: mutation.howTo }),
                version: item.version + 1,
                updatedAt: now,
              }
            : item),
      };
    case "move_item": {
      const item = snapshot.items.find((candidate) => candidate.id === mutation.itemId);
      if (!item) return snapshot;
      const targetSiblings = orderedRows(snapshot.items.filter((candidate) =>
        candidate.sectionId === mutation.sectionId && candidate.id !== mutation.itemId));
      const positioned = positionRows(insertAtBounds(
        targetSiblings,
        {
          ...item,
          sectionId: mutation.sectionId,
          version: item.version + 1,
          updatedAt: now,
        },
        mutation.afterItemId,
        mutation.beforeItemId,
      ));
      return {
        ...snapshot,
        items: [
          ...snapshot.items.filter((candidate) =>
            candidate.sectionId !== mutation.sectionId && candidate.id !== mutation.itemId),
          ...positioned,
        ],
      };
    }
    case "archive_item":
      return {
        ...snapshot,
        items: snapshot.items.filter((item) => item.id !== mutation.itemId),
      };
  }
}

function insertAtBounds<T extends { id: string }>(
  rows: readonly T[],
  row: T,
  afterId?: string | null,
  beforeId?: string | null,
): T[] {
  const next = [...rows];
  const beforeIndex = beforeId ? next.findIndex((candidate) => candidate.id === beforeId) : -1;
  if (beforeIndex >= 0) {
    next.splice(beforeIndex, 0, row);
    return next;
  }
  const afterIndex = afterId ? next.findIndex((candidate) => candidate.id === afterId) : -1;
  next.splice(afterIndex >= 0 ? afterIndex + 1 : next.length, 0, row);
  return next;
}

function positionRows<T extends { positionKey: string }>(rows: readonly T[]): T[] {
  return rows.map((row, index) => ({
    ...row,
    positionKey: `optimistic:${String(index).padStart(6, "0")}`,
  }));
}

function orderedRows<T extends { positionKey: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    if (left.positionKey === right.positionKey) return 0;
    return left.positionKey < right.positionKey ? -1 : 1;
  });
}

function newSection(
  mutation: Extract<ChecklistMutation, { kind: "create_section" }>,
  now: string,
): ChecklistSectionRow {
  return {
    id: mutation.sectionId,
    folderId: mutation.folderId,
    positionKey: "optimistic:000000",
    title: mutation.title,
    archived: false,
    version: 1,
    assigneeKind: null,
    assigneeAgentId: null,
    assigneeSessionId: null,
    assigneeUserId: null,
    createdSessionId: null,
    createdEventId: null,
    updatedSessionId: null,
    updatedEventId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function newItem(
  mutation: Extract<ChecklistMutation, { kind: "create_item" }>,
  now: string,
): ChecklistItemRow {
  return {
    id: mutation.itemId,
    sectionId: mutation.sectionId,
    positionKey: "optimistic:000000",
    title: mutation.title,
    howTo: mutation.howTo ?? "",
    status: "pending",
    archived: false,
    version: 1,
    assigneeKind: null,
    assigneeAgentId: null,
    assigneeSessionId: null,
    assigneeUserId: null,
    createdSessionId: null,
    createdEventId: null,
    updatedSessionId: null,
    updatedEventId: null,
    completedKind: null,
    completedSessionId: null,
    completedEventId: null,
    completedUserId: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
