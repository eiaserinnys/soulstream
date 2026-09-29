import type {
  BoardYjsQuerySql,
} from "../../board-yjs/board_yjs_sql.js";

export type RepositorySql = BoardYjsQuerySql;
export type SqlClient = RepositorySql & {
  begin<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T>;
};

import type { ChecklistItemStatus } from "@soulstream/wire-schema";

export type { ChecklistItemStatus } from "@soulstream/wire-schema";

export type ChecklistAssigneeKind = "agent" | "human" | "session";
export type FolderStatus = "open" | "completed";
export type FolderOperationTargetKind = "folder" | "section" | "item";
export type FolderOperationActorKind = "agent" | "user" | "system" | "llm";
export type FolderCompletionKind = Exclude<FolderOperationActorKind, "system">;

export interface ChecklistAssigneeFields extends Record<string, unknown> {
  assignee_kind: ChecklistAssigneeKind | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
}

export interface FolderRow extends Record<string, unknown> {
  id: string;
  name: string;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  project_page_id: string | null;
  checklist_enabled: boolean;
  status: FolderStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  completed_kind: FolderCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistSectionRow extends ChecklistAssigneeFields {
  id: string;
  folder_id: string;
  position_key: string;
  title: string;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  updated_session_id: string | null;
  updated_event_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistItemRow extends ChecklistAssigneeFields {
  id: string;
  section_id: string;
  position_key: string;
  title: string;
  how_to: string;
  status: ChecklistItemStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  updated_session_id: string | null;
  updated_event_id: number | null;
  completed_kind: FolderCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FolderOperationRow extends Record<string, unknown> {
  id: string;
  folder_id: string | null;
  target_kind: FolderOperationTargetKind;
  target_id: string;
  operation_type: string;
  actor_kind: FolderOperationActorKind;
  actor_session_id: string | null;
  actor_event_id: number | null;
  actor_user_id: string | null;
  idempotency_key: string | null;
  payload_json: Record<string, unknown>;
  reason: string | null;
  created_at: Date;
}

export interface FolderSnapshot {
  folder: FolderRow;
  sections: ChecklistSectionRow[];
  items: ChecklistItemRow[];
}

export type FolderListRow = FolderRow;

export interface FolderMyTurnItemRow extends Record<string, unknown> {
  folder_id: string;
  folder_name: string;
  folder_status: FolderStatus;
  folder_completed_kind: FolderCompletionKind | null;
  folder_completed_session_id: string | null;
  folder_completed_event_id: number | null;
  folder_completed_user_id: string | null;
  folder_completed_at: Date | null;
  section_id: string;
  section_title: string;
  item_id: string;
  item_title: string;
  how_to: string;
  status: ChecklistItemStatus;
  item_version: number;
  effective_assignee_kind: ChecklistAssigneeKind | null;
  effective_assignee_agent_id: string | null;
  effective_assignee_session_id: string | null;
  effective_assignee_user_id: string | null;
}

export interface FolderActorParams {
  actorKind?: FolderOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}

export interface FolderHandoffEvent {
  folderId: string;
  folderName: string;
  itemId: string;
  itemTitle: string;
  status: Extract<ChecklistItemStatus, "completed" | "cancelled">;
  operationId: string;
  eventId: number;
}

export interface ChecklistMutationResult {
  snapshot: FolderSnapshot;
  operation: FolderOperationRow;
  eventId: number;
  idempotent?: boolean;
  handoff?: FolderHandoffEvent;
}

export interface FolderDbPort {
  appendEventTx(
    sql: RepositorySql,
    params: {
      sessionId: string;
      eventType: string;
      payload: string;
      searchableText: string;
      createdAt: Date;
      dedupeKey?: string | null;
    },
  ): Promise<number>;
}

export interface FolderBroadcasterPort {
  emitFolderUpdated(folderId: string, agentSessionId: string | null, headerChanged?: boolean): Promise<void>;
}
