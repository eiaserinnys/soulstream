import type {
  TaskItemRow,
  TaskSectionRow,
  TaskSnapshot,
} from "./task-store";

interface MutationBase {
  taskId: string;
  idempotencyKey: string;
}

interface VersionedMutationBase extends MutationBase {
  expectedVersion: number;
  reason?: string | null;
}

export type TaskChecklistMutation =
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

export function applyTaskMutationOptimistically(
  snapshot: TaskSnapshot,
  mutation: TaskChecklistMutation,
  now = new Date().toISOString(),
): TaskSnapshot {
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
            ? { ...section, title: mutation.title, version: section.version + 1, updated_at: now }
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
          { ...section, version: section.version + 1, updated_at: now },
          mutation.afterSectionId,
          mutation.beforeSectionId,
        )),
      };
    }
    case "archive_section":
      return {
        ...snapshot,
        sections: snapshot.sections.filter((section) => section.id !== mutation.sectionId),
        items: snapshot.items.filter((item) => item.section_id !== mutation.sectionId),
      };
    case "create_item": {
      const created = newItem(mutation, now);
      const siblings = orderedRows(
        snapshot.items.filter((item) => item.section_id === mutation.sectionId),
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
          ...snapshot.items.filter((item) => item.section_id !== mutation.sectionId),
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
                ...(mutation.howTo === undefined ? {} : { how_to: mutation.howTo }),
                version: item.version + 1,
                updated_at: now,
              }
            : item),
      };
    case "move_item": {
      const item = snapshot.items.find((candidate) => candidate.id === mutation.itemId);
      if (!item) return snapshot;
      const targetSiblings = orderedRows(snapshot.items.filter((candidate) =>
        candidate.section_id === mutation.sectionId && candidate.id !== mutation.itemId));
      const positioned = positionRows(insertAtBounds(
        targetSiblings,
        {
          ...item,
          section_id: mutation.sectionId,
          version: item.version + 1,
          updated_at: now,
        },
        mutation.afterItemId,
        mutation.beforeItemId,
      ));
      return {
        ...snapshot,
        items: [
          ...snapshot.items.filter((candidate) =>
            candidate.section_id !== mutation.sectionId && candidate.id !== mutation.itemId),
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

function positionRows<T extends { position_key: string }>(rows: readonly T[]): T[] {
  return rows.map((row, index) => ({
    ...row,
    position_key: `optimistic:${String(index).padStart(6, "0")}`,
  }));
}

function orderedRows<T extends { position_key: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    if (left.position_key === right.position_key) return 0;
    return left.position_key < right.position_key ? -1 : 1;
  });
}

function newSection(
  mutation: Extract<TaskChecklistMutation, { kind: "create_section" }>,
  now: string,
): TaskSectionRow {
  return {
    id: mutation.sectionId,
    task_id: mutation.taskId,
    position_key: "optimistic:000000",
    title: mutation.title,
    archived: false,
    version: 1,
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
    created_session_id: null,
    created_event_id: null,
    updated_session_id: null,
    updated_event_id: null,
    created_at: now,
    updated_at: now,
  };
}

function newItem(
  mutation: Extract<TaskChecklistMutation, { kind: "create_item" }>,
  now: string,
): TaskItemRow {
  return {
    id: mutation.itemId,
    section_id: mutation.sectionId,
    position_key: "optimistic:000000",
    title: mutation.title,
    how_to: mutation.howTo ?? "",
    status: "pending",
    archived: false,
    version: 1,
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
    created_session_id: null,
    created_event_id: null,
    updated_session_id: null,
    updated_event_id: null,
    completed_kind: null,
    completed_session_id: null,
    completed_event_id: null,
    completed_user_id: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
}
