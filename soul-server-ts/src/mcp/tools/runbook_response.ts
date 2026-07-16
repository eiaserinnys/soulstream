import type {
  RunbookAssigneeFields,
  RunbookItemRow,
  RunbookOperationRow,
  RunbookOperationTargetKind,
  RunbookRow,
  RunbookSectionRow,
  RunbookSnapshot,
} from "../../db/session_db_types.js";

export interface RunbookMutationEnvelope {
  snapshot: RunbookSnapshot;
  operation: RunbookOperationRow | Record<string, unknown>;
  idempotent?: boolean;
}

export function formatRunbookMutationResponse(
  result: RunbookMutationEnvelope,
  targetKind: RunbookOperationTargetKind,
  includeSnapshot: boolean,
): RunbookMutationEnvelope | Record<string, unknown> {
  if (includeSnapshot) return result;

  const targetId = readTargetId(result.operation);
  const row = findTargetRow(result.snapshot, targetKind, targetId);
  return {
    operation: result.operation,
    target: { kind: targetKind, row },
    runbook: runbookHeader(result.snapshot.runbook),
    ...(result.idempotent === undefined
      ? {}
      : { idempotent: result.idempotent }),
  };
}

export function formatRunbookReadResponse(
  snapshot: RunbookSnapshot | null,
  options: { view: "full" | "outline"; itemId?: string },
): RunbookSnapshot | Record<string, unknown> | null {
  if (!snapshot) return null;

  if (options.itemId) {
    const item = snapshot.items.find(
      (candidate) => candidate.id === options.itemId,
    );
    if (!item) {
      throw new Error(`runbook item not found: ${options.itemId}`);
    }
    const section = snapshot.sections.find(
      (candidate) => candidate.id === item.section_id,
    );
    if (!section) {
      throw new Error(`runbook section not found for item: ${options.itemId}`);
    }
    return options.view === "outline"
      ? {
          runbook: outlineRunbook(snapshot.runbook),
          section: outlineSection(section),
          item: outlineItem(item),
        }
      : { runbook: snapshot.runbook, section, item };
  }

  if (options.view === "full") return snapshot;
  return {
    runbook: outlineRunbook(snapshot.runbook),
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
    throw new Error("runbook mutation operation is missing");
  }
  const record = operation as Record<string, unknown>;
  const targetId = record.target_id ?? record.targetId;
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("runbook mutation operation is missing target_id");
  }
  return targetId;
}

function findTargetRow(
  snapshot: RunbookSnapshot,
  targetKind: RunbookOperationTargetKind,
  targetId: string,
): RunbookRow | RunbookSectionRow | RunbookItemRow {
  if (targetKind === "runbook") {
    if (snapshot.runbook.id !== targetId) {
      throw new Error(`runbook mutation target not found: ${targetId}`);
    }
    return snapshot.runbook;
  }

  const rows = targetKind === "section" ? snapshot.sections : snapshot.items;
  const row = rows.find((candidate) => candidate.id === targetId);
  if (!row)
    throw new Error(
      `runbook ${targetKind} mutation target not found: ${targetId}`,
    );
  return row;
}

function runbookHeader(runbook: RunbookRow) {
  return {
    id: runbook.id,
    version: runbook.version,
    updated_at: runbook.updated_at,
  };
}

function outlineRunbook(runbook: RunbookRow) {
  return {
    id: runbook.id,
    title: runbook.title,
    status: runbook.status,
    version: runbook.version,
    updated_at: runbook.updated_at,
  };
}

function outlineSection(section: RunbookSectionRow) {
  return {
    id: section.id,
    title: section.title,
    version: section.version,
    assignee: outlineAssignee(section),
  };
}

function outlineItem(item: RunbookItemRow) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    version: item.version,
    assignee: outlineAssignee(item),
  };
}

function outlineAssignee(fields: RunbookAssigneeFields) {
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
