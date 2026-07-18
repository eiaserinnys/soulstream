import type {
  TaskAssigneeFields,
  TaskItemRow,
  TaskOperationRow,
  TaskOperationTargetKind,
  TaskRow,
  TaskSectionRow,
  TaskSnapshot,
} from "../../db/session_db_types.js";

export interface TaskMutationEnvelope {
  snapshot: TaskSnapshot;
  operation: TaskOperationRow | Record<string, unknown>;
  idempotent?: boolean;
}

export function formatTaskMutationResponse(
  result: TaskMutationEnvelope,
  targetKind: TaskOperationTargetKind,
  includeSnapshot: boolean,
): TaskMutationEnvelope | Record<string, unknown> {
  if (includeSnapshot) return result;

  const targetId = readTargetId(result.operation);
  const row = findTargetRow(result.snapshot, targetKind, targetId);
  return {
    operation: result.operation,
    target: { kind: targetKind, row },
    task: taskHeader(result.snapshot.task),
    ...(result.idempotent === undefined
      ? {}
      : { idempotent: result.idempotent }),
  };
}

export function formatTaskReadResponse(
  snapshot: TaskSnapshot | null,
  options: { view: "full" | "outline"; itemId?: string },
): TaskSnapshot | Record<string, unknown> | null {
  if (!snapshot) return null;

  if (options.itemId) {
    const item = snapshot.items.find(
      (candidate) => candidate.id === options.itemId,
    );
    if (!item) {
      throw new Error(`task item not found: ${options.itemId}`);
    }
    const section = snapshot.sections.find(
      (candidate) => candidate.id === item.section_id,
    );
    if (!section) {
      throw new Error(`task section not found for item: ${options.itemId}`);
    }
    return options.view === "outline"
      ? {
          task: outlineTask(snapshot.task),
          section: outlineSection(section),
          item: outlineItem(item),
        }
      : { task: snapshot.task, section, item };
  }

  if (options.view === "full") return snapshot;
  return {
    task: outlineTask(snapshot.task),
    sections: snapshot.sections.map((section) => ({
      ...outlineSection(section),
      items: snapshot.items
        .filter((item) => item.section_id === section.id)
        .map(outlineItem),
    })),
  };
}

function readTargetId(operation: unknown): string {
  if (!operation || typeof operation !== "object") {
    throw new Error("task mutation operation is missing");
  }
  const record = operation as Record<string, unknown>;
  const targetId = record.target_id ?? record.targetId;
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("task mutation operation is missing target_id");
  }
  return targetId;
}

function findTargetRow(
  snapshot: TaskSnapshot,
  targetKind: TaskOperationTargetKind,
  targetId: string,
): TaskRow | TaskSectionRow | TaskItemRow {
  if (targetKind === "task") {
    if (snapshot.task.id !== targetId) {
      throw new Error(`task mutation target not found: ${targetId}`);
    }
    return snapshot.task;
  }

  const rows = targetKind === "section" ? snapshot.sections : snapshot.items;
  const row = rows.find((candidate) => candidate.id === targetId);
  if (!row)
    throw new Error(
      `task ${targetKind} mutation target not found: ${targetId}`,
    );
  return row;
}

function taskHeader(task: TaskRow) {
  return {
    id: task.id,
    version: task.version,
    updated_at: task.updated_at,
  };
}

function outlineTask(task: TaskRow) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    version: task.version,
    updated_at: task.updated_at,
  };
}

function outlineSection(section: TaskSectionRow) {
  return {
    id: section.id,
    title: section.title,
    version: section.version,
    assignee: outlineAssignee(section),
  };
}

function outlineItem(item: TaskItemRow) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    version: item.version,
    assignee: outlineAssignee(item),
  };
}

function outlineAssignee(fields: TaskAssigneeFields) {
  if (!fields.assignee_kind) return null;
  return {
    kind: fields.assignee_kind,
    ...(fields.assignee_agent_id ? { agent_id: fields.assignee_agent_id } : {}),
    ...(fields.assignee_session_id
      ? { session_id: fields.assignee_session_id }
      : {}),
    ...(fields.assignee_user_id ? { user_id: fields.assignee_user_id } : {}),
  };
}
