import type {
  ClaudeTranscriptEntry,
  ClaudeTranscriptKey,
  ClaudeTranscriptSessionSummary,
  RecordObservedChildCompletionBatchResult,
  RecordObservedChildCompletionParams,
  RecordObservedChildCompletionResult,
  RecordSessionDeliveryRelationConsumptionParams,
  RecordSessionDeliveryRelationConsumptionResult,
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryNotificationOutboxRow,
  SessionDeliveryRelationConsumptionRow,
  SessionDeliveryRow,
  AcknowledgeReviewOutcome,
  RegisterSessionParams,
  SessionUpdateFields,
} from "../db/session_db_types.js";
import {
  PersistenceHostTransport,
  type HostClientConfig,
} from "./persistence_host_transport.js";

export {
  PersistenceHostRequestError,
  PersistenceHostTransport,
  type HostClientConfig,
} from "./persistence_host_transport.js";

export type SessionTransitionFields = Pick<
  SessionUpdateFields,
  | "status"
  | "prompt"
  | "client_id"
  | "was_running_at_shutdown"
  | "last_read_event_id"
  | "termination_reason"
  | "termination_detail"
  | "review_state"
>;

export interface SessionMutationHost {
  registerSession(input: RegisterSessionParams, idempotencyKey: string): Promise<void>;
  transitionSession(
    sessionId: string,
    fields: SessionTransitionFields,
    idempotencyKey: string,
    updatedAt?: Date,
  ): Promise<void>;
  renameSession(sessionId: string, displayName: string | null, idempotencyKey: string): Promise<void>;
  deleteSession(sessionId: string, idempotencyKey: string): Promise<void>;
  acknowledgeReview(
    sessionId: string,
    idempotencyKey: string,
    updatedAt?: Date,
  ): Promise<AcknowledgeReviewOutcome>;
}

export function createMissingSessionMutationHost(): SessionMutationHost {
  const missing = async (): Promise<never> => {
    throw new Error("session mutation host is required");
  };
  return {
    registerSession: missing,
    transitionSession: missing,
    renameSession: missing,
    deleteSession: missing,
    acknowledgeReview: missing,
  };
}

export class SessionMutationHostClient implements SessionMutationHost {
  private readonly transport: PersistenceHostTransport;

  constructor(config: HostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
  }

  async registerSession(input: RegisterSessionParams, idempotencyKey: string): Promise<void> {
    await this.transport.request("session-data", "register_session", [{
      ...input,
      idempotencyKey,
    }]);
  }

  async transitionSession(
    sessionId: string,
    fields: SessionTransitionFields,
    idempotencyKey: string,
    updatedAt = new Date(),
  ): Promise<void> {
    await this.transport.request("session-data", "transition_session", [{
      sessionId,
      fields: snakeTransitionFields(fields),
      idempotencyKey,
      updatedAt,
    }]);
  }

  async renameSession(sessionId: string, displayName: string | null, idempotencyKey: string): Promise<void> {
    await this.transport.request("session-data", "rename_session", [{
      sessionId,
      displayName,
      idempotencyKey,
    }]);
  }

  async deleteSession(sessionId: string, idempotencyKey: string): Promise<void> {
    await this.transport.request("session-data", "delete_session", [{ sessionId, idempotencyKey }]);
  }

  acknowledgeReview(
    sessionId: string,
    idempotencyKey: string,
    updatedAt = new Date(),
  ): Promise<AcknowledgeReviewOutcome> {
    return this.transport.request("session-data", "acknowledge_review", [{
      sessionId,
      idempotencyKey,
      updatedAt,
    }]);
  }
}

function snakeTransitionFields(fields: SessionTransitionFields): Record<string, unknown> {
  return {
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.prompt === undefined ? {} : { prompt: fields.prompt }),
    ...(fields.client_id === undefined ? {} : { clientId: fields.client_id }),
    ...(fields.was_running_at_shutdown === undefined
      ? {}
      : { wasRunningAtShutdown: fields.was_running_at_shutdown }),
    ...(fields.last_read_event_id === undefined
      ? {}
      : { lastReadEventId: fields.last_read_event_id }),
    ...(fields.termination_reason === undefined
      ? {}
      : { terminationReason: fields.termination_reason }),
    ...(fields.termination_detail === undefined
      ? {}
      : { terminationDetail: fields.termination_detail }),
    ...(fields.review_state === undefined ? {} : { reviewState: fields.review_state }),
  };
}

export class SessionDeliveryNotificationHostClient {
  constructor(private readonly transport: PersistenceHostTransport) {}

  stageWithQueuedDelivery(params: {
    deliveryId: string;
    leaseOwner: string;
    targetSessionId: string;
    disposition: "queued" | "auto_resume";
    payload: Record<string, unknown>;
  }): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "stage_notification_with_queued_delivery", [params]);
  }

  claimDue(
    targetNodeId: string,
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryNotificationOutboxRow[]> {
    return this.transport.request(
      "session-deliveries",
      "claim_due_notifications",
      [targetNodeId, leaseOwner, limit, leaseMs],
    );
  }

  markPublished(deliveryId: string, leaseOwner: string): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return this.transport.request("session-deliveries", "mark_notification_published", [deliveryId, leaseOwner]);
  }

  retry(
    deliveryId: string,
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    oldestAllowedCreatedAt: Date,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return this.transport.request(
      "session-deliveries",
      "retry_notification",
      [
        deliveryId,
        leaseOwner,
        error,
        nextAttemptAt,
        maxAttempts,
        oldestAllowedCreatedAt,
      ],
    );
  }

  deadLetter(deliveryId: string, leaseOwner: string, error: string): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return this.transport.request(
      "session-deliveries",
      "dead_letter_notification",
      [deliveryId, leaseOwner, error],
    );
  }

  listDeadLetters(limit = 100): Promise<SessionDeliveryNotificationOutboxRow[]> {
    return this.transport.request(
      "session-deliveries",
      "list_dead_letter_notifications",
      [limit],
    );
  }

  requeueDeadLetter(deliveryId: string): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return this.transport.request(
      "session-deliveries",
      "requeue_dead_letter_notification",
      [deliveryId],
    );
  }

  releaseExpiredLeases(maxAttempts: number, oldestAllowedCreatedAt: Date): Promise<number> {
    return this.transport.request(
      "session-deliveries",
      "release_expired_notification_leases",
      [maxAttempts, oldestAllowedCreatedAt],
    );
  }
}

export interface QueuedDeliveryRecoveryScan {
  recoveryNodeId: string;
  staleNodeBefore: Date;
  queuedBefore: Date;
}

export class SessionDeliveryRecoveryHostClient {
  constructor(private readonly transport: PersistenceHostTransport) {}

  claimQueuedAfterNodeRestart(nodeId: string, leaseOwner: string, limit = 100, leaseMs = 15_000): Promise<SessionDeliveryRow[]> {
    return this.transport.request("session-deliveries", "claim_queued_after_node_restart", [nodeId, leaseOwner, limit, leaseMs]);
  }

  claimRecoverableQueued(scan: QueuedDeliveryRecoveryScan, leaseOwner: string, limit = 100, leaseMs = 15_000): Promise<SessionDeliveryRow[]> {
    return this.transport.request("session-deliveries", "claim_recoverable_queued", [scan, leaseOwner, limit, leaseMs]);
  }

  markDeliveredFromTranscript(deliveryId: string, leaseOwner: string, assistantMessageUuid: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "mark_delivered_from_transcript", [deliveryId, leaseOwner, assistantMessageUuid]);
  }

  deferQueuedTranscriptCheck(deliveryId: string, leaseOwner: string, error: string, nextAttemptAt: Date): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "defer_queued_transcript_check", [deliveryId, leaseOwner, error, nextAttemptAt]);
  }
}

export class SessionDeliveryHostClient {
  readonly notifications: SessionDeliveryNotificationHostClient;
  readonly recovery: SessionDeliveryRecoveryHostClient;
  private readonly transport: PersistenceHostTransport;

  constructor(config: HostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
    this.notifications = new SessionDeliveryNotificationHostClient(this.transport);
    this.recovery = new SessionDeliveryRecoveryHostClient(this.transport);
  }

  register(params: RegisterSessionDeliveryParams): Promise<RegisterSessionDeliveryResult> {
    return this.transport.request("session-deliveries", "register", [params]);
  }
  get(deliveryId: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "get", [deliveryId]);
  }
  getByRelation(relationKey: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "get_by_relation", [relationKey]);
  }
  getRelationConsumption(relationKey: string): Promise<SessionDeliveryRelationConsumptionRow | null> {
    return this.transport.request("session-deliveries", "get_relation_consumption", [relationKey]);
  }
  recordRelationConsumed(params: RecordSessionDeliveryRelationConsumptionParams): Promise<RecordSessionDeliveryRelationConsumptionResult> {
    return this.transport.request("session-deliveries", "record_relation_consumed", [params]);
  }
  recordObservedChildCompletion(params: RecordObservedChildCompletionParams): Promise<RecordObservedChildCompletionResult> {
    return this.transport.request("session-deliveries", "record_observed_child_completion", [params]);
  }
  recordObservedChildCompletions(params: RecordObservedChildCompletionParams[]): Promise<RecordObservedChildCompletionBatchResult> {
    return this.transport.request("session-deliveries", "record_observed_child_completions", [params]);
  }
  claim(deliveryId: string, leaseOwner = "legacy", leaseMs = 15_000): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "claim", [deliveryId, leaseOwner, leaseMs]);
  }
  claimForTarget(deliveryId: string, targetSessionId: string, leaseOwner = "legacy", leaseMs = 15_000): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "claim_for_target", [deliveryId, targetSessionId, leaseOwner, leaseMs]);
  }
  beginDispatch(deliveryId: string, leaseOwner?: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "begin_dispatch", [deliveryId, leaseOwner]);
  }
  claimRecoverableCompletionDeliveries(leaseOwner: string, limit = 100, leaseMs = 15_000): Promise<SessionDeliveryRow[]> {
    return this.transport.request("session-deliveries", "claim_recoverable_completion_deliveries", [leaseOwner, limit, leaseMs]);
  }
  deferPending(deliveryId: string, error: string, nextAttemptAt: Date): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "defer_pending", [deliveryId, error, nextAttemptAt]);
  }
  retryLeasedDelivery(deliveryId: string, leaseOwner: string, error: string, nextAttemptAt: Date): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "retry_leased_delivery", [deliveryId, leaseOwner, error, nextAttemptAt]);
  }
  releaseExpiredDeliveryLeases(): Promise<number> {
    return this.transport.request("session-deliveries", "release_expired_delivery_leases", []);
  }
  markQueued(deliveryId: string, leaseOwner?: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "mark_queued", [deliveryId, leaseOwner]);
  }
  markDelivered(deliveryId: string, callerTurnId: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "mark_delivered", [deliveryId, callerTurnId]);
  }
  markConsumed(deliveryId: string, callerTurnId?: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "mark_consumed", [deliveryId, callerTurnId]);
  }
  markConsumedByRelation(relationKey: string, completionId: string, callerTurnId: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "mark_consumed_by_relation", [relationKey, completionId, callerTurnId]);
  }
  markUncertain(deliveryId: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "mark_uncertain", [deliveryId]);
  }
}

export type ClaudeBackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "killed";
export type ClaudeBackgroundTerminalStatus = Exclude<ClaudeBackgroundTaskStatus, "pending" | "running">;
export interface ClaudeBackgroundTaskRow {
  source_node: string; session_id: string; task_id: string; sdk_session_id: string | null;
  status: ClaudeBackgroundTaskStatus; close_reason: string | null; description: string | null;
  summary: string | null; output_file: string | null; tool_use_id: string | null;
  terminal_revision: string | null; notification_delivery_id: string | null;
  created_at: Date; updated_at: Date; terminal_at: Date | null;
}
export interface ObserveClaudeBackgroundTaskParams {
  idempotencyKey?: string;
  sourceNode: string; sessionId: string; taskId: string; sdkSessionId?: string;
  status?: "pending" | "running"; description?: string; summary?: string;
  outputFile?: string; toolUseId?: string; observedAt?: Date;
}
export interface TerminalizeClaudeBackgroundTaskParams extends Omit<ObserveClaudeBackgroundTaskParams, "status"> {
  status: ClaudeBackgroundTerminalStatus; closeReason: string; terminalRevision: string;
  delivery: RegisterSessionDeliveryParams;
}
export type TerminalizeClaudeBackgroundTaskResult =
  | { accepted: true; row: ClaudeBackgroundTaskRow; delivery: SessionDeliveryRow }
  | { accepted: false; row: ClaudeBackgroundTaskRow };

export class ClaudeRuntimeHostClient {
  private readonly transport: PersistenceHostTransport;
  constructor(config: HostClientConfig) { this.transport = new PersistenceHostTransport(config); }
  observe(params: ObserveClaudeBackgroundTaskParams): Promise<ClaudeBackgroundTaskRow> {
    return this.transport.request("claude-runtime", "observe_background_task", [params]);
  }
  terminalize(params: TerminalizeClaudeBackgroundTaskParams): Promise<TerminalizeClaudeBackgroundTaskResult> {
    return this.transport.request("claude-runtime", "terminalize_background_task", [params]);
  }
  get(sourceNode: string, sessionId: string, taskId: string): Promise<ClaudeBackgroundTaskRow | null> {
    return this.transport.request("claude-runtime", "get_background_task", [sourceNode, sessionId, taskId]);
  }
  activeForNode(sourceNode: string, limit = 1_000): Promise<ClaudeBackgroundTaskRow[]> {
    return this.transport.request("claude-runtime", "active_background_tasks_for_node", [sourceNode, limit]);
  }
  appendClaudeTranscriptEntries(key: ClaudeTranscriptKey, entries: ClaudeTranscriptEntry[]): Promise<number> {
    return this.transport.request("claude-runtime", "append_transcript_entries", [key, entries]);
  }
  appendClaudeTranscriptEntriesIdempotent(input: {
    idempotencyKey: string;
    sessionId: string;
    key: ClaudeTranscriptKey;
    entries: ClaudeTranscriptEntry[];
  }): Promise<number> {
    return this.transport.request("claude-runtime", "append_transcript_entries_idempotent", [input]);
  }
  loadClaudeTranscriptEntries(key: ClaudeTranscriptKey): Promise<ClaudeTranscriptEntry[] | null> {
    return this.transport.request("claude-runtime", "load_transcript_entries", [key]);
  }
  listClaudeTranscriptSessions(projectKey: string): Promise<ClaudeTranscriptSessionSummary[]> {
    return this.transport.request("claude-runtime", "list_transcript_sessions", [projectKey]);
  }
  listClaudeTranscriptSubkeys(key: Pick<ClaudeTranscriptKey, "projectKey" | "sessionId">): Promise<string[]> {
    return this.transport.request("claude-runtime", "list_transcript_subkeys", [key]);
  }
  deleteClaudeTranscript(key: ClaudeTranscriptKey): Promise<void> {
    return this.transport.request("claude-runtime", "delete_transcript", [key]);
  }
  deleteClaudeTranscriptIdempotent(input: {
    idempotencyKey: string;
    sessionId: string;
    key: ClaudeTranscriptKey;
  }): Promise<void> {
    return this.transport.request("claude-runtime", "delete_transcript_idempotent", [input]);
  }
}

export type BindingStepState = "pending" | "bound" | "completed" | "manual_repair";
export interface SessionPageBindingRow {
  session_id: string; node_id: string; target_page_id: string | null; target_block_id: string | null;
  target_expected_version: number | null; daily_date: string; session_type: string;
  legacy_folder_id: string | null; legacy_container_kind: string | null;
  legacy_container_id: string | null; source_task_item_id: string | null;
  page_state: "pending" | "bound" | "manual_repair";
  legacy_state: "pending" | "completed" | "manual_repair";
  attempts: number; last_error: string | null; next_retry_at: Date;
}
export interface EnqueueSessionPageBinding {
  sessionId: string; nodeId: string; targetPageId: string | null; targetBlockId: string | null;
  targetExpectedVersion: number | null; initialPageState: "pending" | "bound";
  dailyDate: string; sessionType: string; legacyFolderId: string | null;
  legacyContainerKind: string | null; legacyContainerId: string | null; sourceTaskItemId: string | null;
}

export class SessionPageBindingHostClient {
  private readonly transport: PersistenceHostTransport;
  constructor(config: HostClientConfig) { this.transport = new PersistenceHostTransport(config); }
  enqueue(input: EnqueueSessionPageBinding): Promise<SessionPageBindingRow> {
    return this.transport.request("session-page-bindings", "enqueue", [input]);
  }
  get(sessionId: string): Promise<SessionPageBindingRow | null> {
    return this.transport.request("session-page-bindings", "get", [sessionId]);
  }
  listForSessions(sessionIds: string[]): Promise<SessionPageBindingRow[]> {
    return this.transport.request("session-page-bindings", "list_for_sessions", [sessionIds]);
  }
  listDue(nodeId: string, limit = 50): Promise<SessionPageBindingRow[]> {
    return this.transport.request("session-page-bindings", "list_due", [nodeId, limit]);
  }
  async markPageBound(sessionId: string): Promise<void> {
    await this.transport.request("session-page-bindings", "mark_page_bound", [sessionId]);
  }
  async markLegacyCompleted(sessionId: string): Promise<void> {
    await this.transport.request("session-page-bindings", "mark_legacy_completed", [sessionId]);
  }
  async markFailure(sessionId: string, step: "page" | "legacy", error: string, manualRepair: boolean): Promise<void> {
    await this.transport.request("session-page-bindings", "mark_failure", [sessionId, step, error, manualRepair]);
  }
}
