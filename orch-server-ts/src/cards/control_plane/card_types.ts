import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type {
  BoardYjsQuerySql,
} from "../../board-yjs/board_yjs_sql.js";

export type RepositorySql = BoardYjsQuerySql;
export type SqlClient = RepositorySql & {
  begin<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T>;
};

import type { CardStatus } from "@soulstream/wire-schema";
import type { CardColor } from "@soulstream/wire-schema/card-colors";

export type { CardStatus } from "@soulstream/wire-schema";

export type CardAssigneeKind = "agent" | "human" | "session";
export type FolderStatus = "open" | "completed";
export type FolderOperationTargetKind = "folder" | "section" | "card";
export type FolderOperationActorKind = "agent" | "user" | "system" | "llm";
export type FolderCompletionKind = Exclude<FolderOperationActorKind, "system">;

export interface CardAssigneeFields extends Record<string, unknown> {
  assignee_kind: CardAssigneeKind | null;
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

export interface CardRow extends CardAssigneeFields {
  id: string;
  number: number;
  color: CardColor;
  folder_id: string;
  position_key: string;
  title: string;
  request: string;
  attachments: CardAttachment[];
  queue_position_key: string | null;
  brief: string;
  blocked_kind: "limit" | "question" | "no_report" | null;
  blocked_detail: string | null;
  node_id: string | null;
  model_preset: string | null;
  status: CardStatus;
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
  cards: CardRow[];
}

export type FolderListRow = FolderRow;

export interface FolderActorParams {
  actorKind?: FolderOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}

export interface CardMutationResult {
  snapshot: FolderSnapshot;
  operation: FolderOperationRow;
  eventId: number;
  idempotent?: boolean;
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
  emitCardUpdated?(cardId: string, folderId: string): Promise<void>;
}
