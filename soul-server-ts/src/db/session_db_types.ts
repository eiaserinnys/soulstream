import type postgres from "postgres";
import type { SessionBindingWarning } from "@soulstream/page-model";

import type { ReviewState, TaskStatus, TerminationReason } from "../task/task_models.js";
import type { SupervisorWakeDispatchState } from "../supervisor/wake_dispatch_state.js";

export type SessionType = "claude" | "llm";

/** 화이트리스트 컬럼만 허용. 위반 시 진입 시점 throw. */
export interface SessionUpdateFields {
  folder_id?: string | null;
  display_name?: string | null;
  status?: TaskStatus;
  prompt?: string;
  client_id?: string | null;
  last_message?: LastMessageRow;
  metadata?: unknown[];
  was_running_at_shutdown?: boolean;
  last_event_id?: number;
  last_read_event_id?: number;
  termination_reason?: TerminationReason | null;
  termination_detail?: string | null;
  review_state?: ReviewState;
}

export interface LastMessageRow {
  type: string;
  preview: string;
  timestamp: string;
}

export interface FolderRow {
  id: string;
  name: string;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  created_at?: Date | string;
}

export interface CatalogFolderRow {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  createdAt?: string;
}

export type BoardItemType =
  | "session"
  | "markdown"
  | "subfolder"
  | "asset"
  | "frame"
  | "runbook"
  | "custom_view";

export type BoardContainerKind = "folder" | "runbook";

export interface BoardYjsContainerRef {
  containerKind: BoardContainerKind;
  containerId: string;
}

export interface BoardYjsContainerScope extends BoardYjsContainerRef {
  folderId: string;
}

export interface CatalogBoardItemRow {
  id: string;
  folderId: string;
  containerKind?: BoardContainerKind;
  containerId?: string;
  membershipKind?: "primary" | "reference";
  sourceRunbookItemId?: string | null;
  itemType: BoardItemType;
  itemId: string;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MarkdownDocumentRow {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomViewRow {
  id: string;
  boardItemId: string;
  title: string | null;
  html: string;
  revision: number;
  archived: boolean;
  createdSessionId: string | null;
  createdEventId: number | null;
  updatedSessionId: string | null;
  updatedEventId: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardYjsSeed {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

export interface BoardYjsReplica {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

/** `session_get` 반환 행 (sessions 테이블 컬럼 매핑). */
export interface SessionRow {
  session_id: string;
  folder_id: string | null;
  display_name: string | null;
  node_id: string | null;
  session_type: string | null;
  status: string | null;
  prompt: string | null;
  client_id: string | null;
  claude_session_id: string | null;
  last_message: unknown;
  metadata: unknown;
  was_running_at_shutdown: boolean;
  last_event_id: number | null;
  last_read_event_id: number | null;
  created_at: Date;
  updated_at: Date;
  agent_id: string | null;
  caller_session_id: string | null;
  predecessor_session_id: string | null;
  notify_completion?: boolean | null;
  away_summary: string | null;
  termination_reason: string | null;
  termination_detail: string | null;
  review_required?: boolean;
  review_state?: ReviewState;
}

export interface RunningSessionSummaryRow {
  session_id: string;
  display_name: string | null;
  node_id: string | null;
  folder_id: string | null;
  folder_name: string | null;
  updated_at: Date;
}

export interface ListSessionSummaryRow {
  session_id: string;
  display_name: string | null;
  status: string | null;
  session_type: string | null;
  created_at: Date;
  updated_at: Date;
  event_count: number;
  away_summary: string | null;
  caller_session_id: string | null;
  predecessor_session_id: string | null;
  last_event_id: number | null;
  last_read_event_id: number | null;
  node_id: string | null;
  review_required?: boolean;
  review_state?: ReviewState;
}

export interface UpstreamSessionDumpRow extends ListSessionSummaryRow {
  agent_id: string | null;
  prompt: string | null;
  folder_id: string | null;
  metadata: unknown;
  last_message: unknown;
  client_id: string | null;
  review_required?: boolean;
  review_state?: ReviewState;
  binding_warnings: SessionBindingWarning[];
}

export interface RegisterSessionParams {
  sessionId: string;
  nodeId: string;
  agentId: string | null;
  /** Codex thread id (또는 claude session id — 컬럼 의미는 "backend session id"). */
  claudeSessionId: string | null;
  sessionType: SessionType;
  prompt: string;
  clientId: string | null;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  notifyCompletion?: boolean | null;
  reviewRequired?: boolean;
  reviewState?: ReviewState;
}

export type AcknowledgeReviewOutcome =
  | "acknowledged"
  | "already_acknowledged"
  | "not_required"
  | "not_pending"
  | "not_found";

export interface AppendEventParams {
  sessionId: string;
  eventType: string;
  /** JSON-encoded payload string. */
  payload: string;
  searchableText: string;
  createdAt: Date;
  dedupeKey?: string | null;
}

export type RunbookAssigneeKind = "agent" | "human" | "session";
export type RunbookItemStatus =
  | "pending"
  | "in_progress"
  | "review"
  | "completed"
  | "cancelled";
export type RunbookStatus = "open" | "completed";
export type RunbookOperationTargetKind = "runbook" | "section" | "item";
export type RunbookOperationActorKind = "agent" | "user" | "system";
export type RunbookCompletionKind = Exclude<RunbookOperationActorKind, "system">;

export interface RunbookAssigneeFields {
  assignee_kind: RunbookAssigneeKind | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
}

export interface RunbookRow {
  id: string;
  board_item_id: string;
  title: string;
  status: RunbookStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  completed_kind: RunbookCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunbookSectionRow extends RunbookAssigneeFields {
  id: string;
  runbook_id: string;
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

export interface RunbookItemRow extends RunbookAssigneeFields {
  id: string;
  section_id: string;
  position_key: string;
  title: string;
  how_to: string;
  status: RunbookItemStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  updated_session_id: string | null;
  updated_event_id: number | null;
  completed_kind: "agent" | "user" | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunbookOperationRow {
  id: string;
  runbook_id: string | null;
  target_kind: RunbookOperationTargetKind;
  target_id: string;
  operation_type: string;
  actor_kind: RunbookOperationActorKind;
  actor_session_id: string | null;
  actor_event_id: number | null;
  actor_user_id: string | null;
  idempotency_key: string | null;
  payload_json: Record<string, unknown>;
  reason: string | null;
  created_at: Date;
}

export interface RunbookSnapshot {
  runbook: RunbookRow;
  sections: RunbookSectionRow[];
  items: RunbookItemRow[];
}

export interface RunbookListRow {
  id: string;
  board_item_id: string;
  folder_id: string;
  title: string;
  status: RunbookStatus;
  archived: boolean;
  version: number;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  completed_kind: RunbookCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunbookMyTurnItemRow {
  runbook_id: string;
  runbook_title: string;
  runbook_status: RunbookStatus;
  board_item_id: string;
  runbook_completed_kind: RunbookCompletionKind | null;
  runbook_completed_session_id: string | null;
  runbook_completed_event_id: number | null;
  runbook_completed_user_id: string | null;
  runbook_completed_at: Date | null;
  section_id: string;
  section_title: string;
  item_id: string;
  item_title: string;
  how_to: string;
  status: RunbookItemStatus;
  item_version: number;
  effective_assignee_kind: RunbookAssigneeKind | null;
  effective_assignee_agent_id: string | null;
  effective_assignee_session_id: string | null;
  effective_assignee_user_id: string | null;
}

export interface AppendSupervisorEventParams {
  sourceNode: string;
  sourceSessionId: string;
  sourceEventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface SupervisorAppendResult {
  offset: number;
  inserted: boolean;
  contiguousUpto: number;
  highestSeenEventId: number;
  gapStart: number | null;
  gapEnd: number | null;
}

export interface SupervisorEventRow {
  offset: number;
  sourceNode: string;
  sourceSessionId: string;
  sourceEventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  insertedAt: Date;
}

export interface SupervisorSourceCursorRow {
  sourceNode: string;
  sourceSessionId: string;
  contiguousUpto: number;
  highestSeenEventId: number;
  gapStart: number | null;
  gapEnd: number | null;
  updatedAt: Date;
}

export interface SupervisorRegistryUpsertParams {
  role: string;
  activeSessionId: string | null;
  epoch: number;
  cursorOffset: number;
  handoverState: string;
  cumulativeTokens: number;
  compactionCount: number;
  lastSeenAt: Date | null;
}

export interface SupervisorRegistryRow extends SupervisorRegistryUpsertParams {
  wakeDispatchState?: SupervisorWakeDispatchState;
  wakeLastSignature?: string | null;
  wakeRepeatCount?: number;
  wakeBlockedReason?: string | null;
  wakeBlockedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupervisorWakeDispatchStateParams {
  role: string;
  state: SupervisorWakeDispatchState;
  lastSignature?: string | null;
  repeatCount: number;
  blockedReason?: string | null;
  blockedAt?: Date | null;
}

export interface ClaudeTranscriptKey {
  projectKey: string;
  sessionId: string;
  subpath?: string | null;
}

export type ClaudeTranscriptEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [k: string]: unknown;
};

export interface ClaudeTranscriptSessionSummary {
  sessionId: string;
  mtime: number;
}

/**
 * postgres.js 인스턴스를 외부에서 주입 가능하게 한 type alias.
 *
 * 테스트 시 fake sql 함수를 주입하여 stored proc 호출을 검증한다.
 * production은 `postgres(databaseUrl, options)`로 생성된 인스턴스.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlClient = postgres.Sql<any>;
