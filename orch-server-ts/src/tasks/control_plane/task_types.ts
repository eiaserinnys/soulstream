import type {
  BoardYjsQuerySql,
} from "../../board-yjs/board_yjs_sql.js";

export type RepositorySql = BoardYjsQuerySql;
export type SqlClient = RepositorySql & {
  begin<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T>;
};

export type TaskAssigneeKind = "agent" | "human" | "session";
export type TaskItemStatus = "pending" | "in_progress" | "review" | "completed" | "cancelled";
export type TaskStatus = "open" | "completed";
export type TaskOperationTargetKind = "task" | "section" | "item";
export type TaskOperationActorKind = "agent" | "user" | "system" | "llm";
export type TaskCompletionKind = Exclude<TaskOperationActorKind, "system">;

export interface TaskAssigneeFields extends Record<string, unknown> {
  assignee_kind: TaskAssigneeKind | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
}

export interface TaskRow extends Record<string, unknown> {
  id: string;
  board_item_id: string;
  title: string;
  status: TaskStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  completed_kind: TaskCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskSectionRow extends TaskAssigneeFields {
  id: string;
  task_id: string;
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

export interface TaskItemRow extends TaskAssigneeFields {
  id: string;
  section_id: string;
  position_key: string;
  title: string;
  how_to: string;
  status: TaskItemStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  updated_session_id: string | null;
  updated_event_id: number | null;
  completed_kind: TaskCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskOperationRow extends Record<string, unknown> {
  id: string;
  task_id: string | null;
  target_kind: TaskOperationTargetKind;
  target_id: string;
  operation_type: string;
  actor_kind: TaskOperationActorKind;
  actor_session_id: string | null;
  actor_event_id: number | null;
  actor_user_id: string | null;
  idempotency_key: string | null;
  payload_json: Record<string, unknown>;
  reason: string | null;
  created_at: Date;
}

export interface TaskSnapshot {
  task: TaskRow;
  sections: TaskSectionRow[];
  items: TaskItemRow[];
}

export interface TaskListRow extends Record<string, unknown> {
  id: string;
  board_item_id: string;
  folder_id: string;
  title: string;
  status: TaskStatus;
  archived: boolean;
  version: number;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  completed_kind: TaskCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskMyTurnItemRow extends Record<string, unknown> {
  task_id: string;
  task_title: string;
  task_status: TaskStatus;
  board_item_id: string;
  task_completed_kind: TaskCompletionKind | null;
  task_completed_session_id: string | null;
  task_completed_event_id: number | null;
  task_completed_user_id: string | null;
  task_completed_at: Date | null;
  section_id: string;
  section_title: string;
  item_id: string;
  item_title: string;
  how_to: string;
  status: TaskItemStatus;
  item_version: number;
  effective_assignee_kind: TaskAssigneeKind | null;
  effective_assignee_agent_id: string | null;
  effective_assignee_session_id: string | null;
  effective_assignee_user_id: string | null;
}

export interface TaskActorParams {
  actorKind?: TaskOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}

export interface TaskHandoffEvent {
  taskId: string;
  taskTitle: string;
  boardItemId: string;
  itemId: string;
  itemTitle: string;
  status: Extract<TaskItemStatus, "completed" | "cancelled">;
  operationId: string;
  eventId: number;
}

export interface TaskMutationResult {
  snapshot: TaskSnapshot;
  operation: TaskOperationRow;
  eventId: number;
  idempotent?: boolean;
  handoff?: TaskHandoffEvent;
}

export interface TaskDbPort {
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

export interface TaskBroadcasterPort {
  emitTaskUpdated(agentSessionId: string, taskId: string, boardItemId: string): Promise<void>;
}
