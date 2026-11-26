import type { CardAssigneeKind, FolderStatus, FolderOperationActorKind, FolderCompletionKind } from "@soulstream/mcp-contract";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type {
  FolderContentQuerySql,
} from "../../board/folder_content_sql.js";

export type RepositorySql = FolderContentQuerySql;
export type SqlClient = RepositorySql & {
  begin<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T>;
};

import type { CardStatus } from "@soulstream/wire-schema";
import type { CardColor } from "@soulstream/wire-schema/card-colors";
import type { CardItem, CardNow } from "../card_item_rules.js";
import type { CardDependency } from "../card_dependencies.js";

/** PAS 판에 장을 남기지 않는 상태. 보류는 끝나지 않았지만 사용자가 내린 카드다. */
export function isCardOffBoard(status: CardStatus): boolean {
  return status === "done" || status === "cancelled" || status === "on_hold";
}

export type FolderOperationTargetKind = "folder" | "section" | "card";

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
  number: number | null;
  color: CardColor;
  folder_id: string;
  position_key: string;
  title: string;
  request: string;
  attachments: CardAttachment[];
  items: CardItem[];
  now: CardNow | null;
  queue_position_key: string | null;
  brief: string;
  blocked_kind: "limit" | "question" | "no_report" | null;
  blocked_detail: string | null;
  wake_at: Date | null;
  waiting_for: string | null;
  limit_resume_session_id: string | null;
  limit_resume_at: Date | null;
  snoozed_until: Date | null;
  node_id: string | null;
  model_preset: string | null;
  status: CardStatus;
  dependsOn?: CardDependency[];
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
  status_changed_at?: Date;
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

export interface CardLatestActivity {
  kind: "instruction" | "report";
  format: "markdown" | "html";
  body: string;
  createdAt: string;
}

/** A card row together with the latest activity preview the projection adds. */
export interface ProjectedCard extends CardRow {
  latest_activity: CardLatestActivity | null;
}

/**
 * Mutation answers describe the folder plus the one card the operation touched.
 * The folder's whole card list is only for folder detail reads (`FolderSnapshot`).
 */
export interface CardMutationSnapshot {
  folder: FolderRow;
  card: ProjectedCard | null;
}

export interface FolderActorParams {
  actorKind?: FolderOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}

export interface CardMutationResult {
  snapshot: CardMutationSnapshot;
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
