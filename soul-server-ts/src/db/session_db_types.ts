import type { SessionBindingWarning } from "@soulstream/page-model";
import type {
  BoardItemType,
  ChecklistItemStatus,
} from "@soulstream/wire-schema";

export type {
  BoardItemType,
  ChecklistItemStatus,
} from "@soulstream/wire-schema";

import type {
  ReviewState,
  TaskStatus as SessionTaskStatus,
  TerminationReason,
} from "../task/task_models.js";
import type {
  DeliveryAggregateState,
  DeliveryIntent,
  DeliveryState,
} from "../task/delivery_contract.js";

export type SessionType = "claude" | "llm";

/** 화이트리스트 컬럼만 허용. 위반 시 진입 시점 throw. */
export interface SessionUpdateFields {
  folder_id?: string | null;
  display_name?: string | null;
  status?: SessionTaskStatus;
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
  checklist_enabled: boolean;
  status: FolderStatus;
  archived: boolean;
  version: number;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  project_page_id: string | null;
  created_session_id: string | null;
  created_event_id: number | null;
  completed_kind: FolderCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface CatalogSessionAssignmentRow {
  session_id: string;
  folder_id: string | null;
  display_name: string | null;
}

export interface CatalogFolderRow {
  id: string;
  name: string;
  checklistEnabled: boolean;
  status: "open" | "completed";
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  projectPageId?: string | null;
  createdAt?: string;
}

export interface CatalogBoardItemRow {
  id: string;
  folderId: string;
  membershipKind?: "primary" | "reference";
  sourceChecklistItemId?: string | null;
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
  createdActorKind: "agent" | "user" | "system" | "llm";
  createdSessionId: string | null;
  createdEventId: number | null;
  updatedActorKind: "agent" | "user" | "system" | "llm";
  updatedSessionId: string | null;
  updatedEventId: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export type FolderItemCounts = Record<BoardItemType, number>;

export interface FolderSessionRecord {
  agentSessionId: string;
  displayName: string | null;
  lastUserMessagePreview: string | null;
  status: string | null;
  agentId: string | null;
  sessionType: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  awaySummary: string | null;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  nodeId: string | null;
  lastEventId: number | null;
  lastReadEventId: number | null;
}

export interface FolderMarkdownRecord {
  id: string;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface FolderTitleRecord {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

export interface FolderSubfolderRecord {
  id: string;
  title: string | null;
}

export interface FolderItemRecord {
  boardItem: CatalogBoardItemRow;
  archived: boolean;
  session?: FolderSessionRecord;
  markdown?: FolderMarkdownRecord;
  customView?: FolderTitleRecord;
  asset?: FolderTitleRecord;
  subfolder?: FolderSubfolderRecord;
}

export interface ListFolderItemsParams {
  folderId: string;
  query: string | null;
  includeArchived: boolean;
  itemTypes: BoardItemType[] | null;
  limit: number;
  cursor: number;
  scanLimit?: number | null;
}

export interface ListFolderItemsResult {
  items: FolderItemRecord[];
  total: number;
  counts: FolderItemCounts;
  scan: {
    limit: number;
    scannedItems: number;
    truncated: boolean;
  } | null;
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
  model_preset?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  caller_session_id: string | null;
  predecessor_session_id: string | null;
  notify_completion?: boolean | null;
  away_summary: string | null;
  termination_reason: string | null;
  termination_detail: string | null;
  termination_event_id?: number | null;
  last_assistant_text?: string | null;
  review_required?: boolean;
  review_state?: ReviewState;
  execution_registration_id?: string | null;
  execution_command_id?: string | null;
  worktree_id?: string | null;
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
  agent_id: string | null;
  model_preset: string | null;
  model: string | null;
  reasoning_effort: string | null;
  review_required?: boolean;
  review_state?: ReviewState;
}

export interface UpstreamSessionDumpRow extends ListSessionSummaryRow {
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
  status: SessionTaskStatus;
  createdAt: Date;
  updatedAt: Date;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  modelPreset?: string | null;
  model?: string | null;
  /** Effort resolved at creation. Null keeps the pre-089 legacy behaviour. */
  reasoningEffort?: string | null;
  notifyCompletion?: boolean | null;
  /** Present on the central-review wire contract; omitted by legacy workers. */
  callerInfo?: Record<string, unknown> | null;
  reviewRequired?: boolean;
  reviewState?: ReviewState;
}

export interface RegisterSessionWithWorktreeParams extends RegisterSessionParams {
  worktreeId: string;
  /** Trusted MCP/upstream caller used for central ownership verification. */
  worktreeActorSessionId: string;
  /** Primary task container selected for the new session, or null. */
  ownerFolderId: string | null;
}

export type RegisterSessionReviewResult = {
  reviewRequired: boolean;
  reviewState: ReviewState;
  reviewDecision?: "central_policy" | "legacy_worker";
  policyVersion?: number | null;
};

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

export interface SessionDeliveryRow {
  delivery_id: string;
  enqueue_sequence?: string | number;
  target_session_id: string | null;
  source_session_id: string | null;
  relation_key: string;
  completion_id: string | null;
  intent: DeliveryIntent;
  source: string;
  producer_kind: string | null;
  producer_id: string | null;
  producer_terminal_revision: string | null;
  parent_delivery_id: string | null;
  caller_turn_id: string | null;
  payload_hash: string;
  payload: Record<string, unknown>;
  state: DeliveryState;
  aggregate_state: DeliveryAggregateState;
  created_at: Date;
  updated_at: Date;
  claimed_at: Date | null;
  dispatching_at: Date | null;
  attempt_token: string | null;
  attempt_expires_at: Date | null;
  /** Retry budget spent; accepted admissions are recorded in session_delivery_attempts. */
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  queued_at: Date | null;
  delivered_at: Date | null;
  consumed_at: Date | null;
  superseded_at: Date | null;
  superseded_terminal_revision: string | null;
  target_receipt_id: string | null;
  target_receipt_at: Date | null;
  consumed_reason: string | null;
  dead_letter_reason: string | null;
  dead_lettered_at: Date | null;
}

export interface RegisterSessionDeliveryParams {
  deliveryId: string;
  targetSessionId?: string | null;
  sourceSessionId?: string | null;
  relationKey: string;
  completionId?: string | null;
  intent: DeliveryIntent;
  source: string;
  producerKind?: string | null;
  producerId?: string | null;
  producerTerminalRevision?: string | null;
  parentDeliveryId?: string | null;
  callerTurnId?: string | null;
  payloadHash: string;
  payload: Record<string, unknown>;
  createdAt?: Date;
}

export interface RegisterSessionDeliveryResult {
  row: SessionDeliveryRow;
  inserted: boolean;
  conflict: boolean;
}

export interface SessionDeliveryRelationConsumptionRow {
  relation_key: string;
  completion_id: string;
  caller_session_id: string;
  consumed_turn_id: string;
  consumed_at: Date;
}

export interface RecordSessionDeliveryRelationConsumptionParams {
  relationKey: string;
  completionId: string;
  callerSessionId: string;
  consumedTurnId: string;
}

export interface RecordSessionDeliveryRelationConsumptionResult {
  relation: SessionDeliveryRelationConsumptionRow;
  relationInserted: boolean;
  deliveryConsumed: boolean;
}

export interface RecordObservedChildCompletionParams
  extends RecordSessionDeliveryRelationConsumptionParams {
  childSessionId: string;
  observedRevision: number;
}

export type RecordObservedChildCompletionResult =
  | "recorded"
  | "not_found"
  | "not_child_caller"
  | "not_terminal"
  | "missing_terminal_revision"
  | "revision_mismatch";

export type RecordObservedChildCompletionFailure =
  Exclude<RecordObservedChildCompletionResult, "recorded">;

export type RecordObservedChildCompletionBatchResult =
  | { status: "recorded" }
  | {
      status: RecordObservedChildCompletionFailure;
      childSessionId: string;
    };

export interface SessionDeliveryNotificationOutboxRow {
  delivery_id: string;
  target_session_id: string;
  payload: Record<string, unknown>;
  disposition: "queued" | "auto_resume";
  state: "pending" | "claimed" | "published" | "dead_letter";
  projection_state: "staged" | "publishing" | "published" | "discarded";
  target_receipt_id: string | null;
  target_receipt_at: Date | null;
  attempt_token: string | null;
  attempt_expires_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  dead_lettered_at: Date | null;
}

export type ChecklistAssigneeKind = "agent" | "human" | "session";
export type FolderStatus = "open" | "completed";
export type FolderOperationTargetKind = "folder" | "section" | "item";
export type FolderOperationActorKind = "agent" | "user" | "system" | "llm";
export type FolderCompletionKind = Exclude<FolderOperationActorKind, "system">;

export interface ChecklistAssigneeFields {
  assignee_kind: ChecklistAssigneeKind | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
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

export interface FolderOperationRow {
  id: string;
  folderId: string;
  targetKind: FolderOperationTargetKind;
  targetId: string;
  operationType: string;
  actorKind: FolderOperationActorKind;
  actorSessionId: string | null;
  actorEventId: number | null;
  actorUserId: string | null;
  idempotencyKey: string | null;
  payloadJson: Record<string, unknown>;
  reason: string | null;
  createdAt: string;
}

/** Folder host HTTP rows use camelCase; direct get_all rows use FolderRow above. */
export interface FolderSnapshot {
  folder: Record<string, unknown> & {
    id: string;
    name: string;
    checklistEnabled: boolean;
    status: FolderStatus;
    archived: boolean;
    version: number;
    sortOrder: number;
    settings: Record<string, unknown>;
    parentFolderId: string | null;
    projectPageId: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
  sections: Array<Record<string, unknown> & { id: string }>;
  items: Array<Record<string, unknown> & { id: string; sectionId: string }>;
}

export interface ChildFolderRow {
  id: string;
  board_item_id: string;
  folder_id: string;
  title: string;
  status: FolderStatus;
  archived: boolean;
  version: number;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  completed_kind: FolderCompletionKind | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistMyTurnItemRow {
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

/** SQL boundary used by legacy repository test fixtures, never constructed by the worker. */
export type SqlClient = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T | Promise<T>;
  <T extends Record<string, unknown>>(
    value: T,
    ...columns: Array<Extract<keyof T, string>>
  ): unknown;
  readonly json: (value: unknown) => unknown;
  readonly end?: (options?: { readonly timeout?: number }) => Promise<void>;
};
