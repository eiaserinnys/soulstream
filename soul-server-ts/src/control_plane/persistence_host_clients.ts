import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";
import type {
  AppendSupervisorEventParams,
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
  SupervisorAppendResult,
  SupervisorEventRow,
  SupervisorRegistryRow,
  SupervisorRegistryUpsertParams,
  SupervisorSourceCursorRow,
  SupervisorWakeDispatchStateParams,
} from "../db/session_db_types.js";

type HostClientConfig = { orch: OrchProxyConfig; logger: Logger };

class PersistenceHostTransport {
  constructor(private readonly config: HostClientConfig) {}

  async request<T>(domain: string, operation: string, args: unknown[]): Promise<T> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/${domain}/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify({ args: snakeCase(args) }),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      this.config.logger.warn(
        { domain, operation, status: response.status, message },
        "persistence host request failed",
      );
      throw new Error(`${domain} host ${operation} failed: ${message || response.statusText}`);
    }
    return reviveDates(await response.json()) as T;
  }
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

  claimDue(leaseOwner: string, limit = 100, leaseMs = 15_000): Promise<SessionDeliveryNotificationOutboxRow[]> {
    return this.transport.request("session-deliveries", "claim_due_notifications", [leaseOwner, limit, leaseMs]);
  }

  markPublished(deliveryId: string, leaseOwner: string): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return this.transport.request("session-deliveries", "mark_notification_published", [deliveryId, leaseOwner]);
  }

  retry(deliveryId: string, leaseOwner: string, error: string, nextAttemptAt: Date): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return this.transport.request("session-deliveries", "retry_notification", [deliveryId, leaseOwner, error, nextAttemptAt]);
  }

  releaseExpiredLeases(): Promise<number> {
    return this.transport.request("session-deliveries", "release_expired_notification_leases", []);
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
  claimForCurrentSupervisor(deliveryId: string, supervisorRole: string, leaseOwner = "legacy", leaseMs = 15_000): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "claim_for_current_supervisor", [deliveryId, supervisorRole, leaseOwner, leaseMs]);
  }
  beginDispatch(deliveryId: string, leaseOwner?: string): Promise<SessionDeliveryRow | null> {
    return this.transport.request("session-deliveries", "begin_dispatch", [deliveryId, leaseOwner]);
  }
  claimRecoverableCompletionDeliveries(leaseOwner: string, limit = 100, leaseMs = 15_000): Promise<SessionDeliveryRow[]> {
    return this.transport.request("session-deliveries", "claim_recoverable_completion_deliveries", [leaseOwner, limit, leaseMs]);
  }
  repairInferredSupervisorCompletionTargets(): Promise<number> {
    return this.transport.request("session-deliveries", "repair_inferred_supervisor_completion_targets", []);
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

export class SupervisorHostClient {
  private readonly transport: PersistenceHostTransport;
  constructor(config: HostClientConfig) { this.transport = new PersistenceHostTransport(config); }
  appendSupervisorEvent(params: AppendSupervisorEventParams): Promise<SupervisorAppendResult> {
    return this.transport.request("supervisors", "append_event", [params]);
  }
  readSupervisorEventsAfter(afterOffset = 0, limit = 100): Promise<SupervisorEventRow[]> {
    return this.transport.request("supervisors", "read_events_after", [afterOffset, limit]);
  }
  getSupervisorEventHeadOffset(): Promise<number> {
    return this.transport.request("supervisors", "get_event_head_offset", []);
  }
  getSupervisorSourceCursor(sourceNode: string, sourceSessionId: string): Promise<SupervisorSourceCursorRow | null> {
    return this.transport.request("supervisors", "get_source_cursor", [sourceNode, sourceSessionId]);
  }
  setSupervisorSourceCursor(params: { sourceNode: string; sourceSessionId: string; contiguousUpto: number; highestSeenEventId: number; gapStart?: number | null; gapEnd?: number | null }): Promise<SupervisorSourceCursorRow> {
    return this.transport.request("supervisors", "set_source_cursor", [params]);
  }
  getSupervisorConsumerCursor(supervisorId: string): Promise<number> {
    return this.transport.request("supervisors", "get_consumer_cursor", [supervisorId]);
  }
  setSupervisorConsumerCursor(supervisorId: string, cursorOffset: number): Promise<number> {
    return this.transport.request("supervisors", "set_consumer_cursor", [supervisorId, cursorOffset]);
  }
  setSupervisorWakeDispatchState(params: SupervisorWakeDispatchStateParams): Promise<SupervisorRegistryRow> {
    return this.transport.request("supervisors", "set_wake_dispatch_state", [params]);
  }
  upsertSupervisorRegistry(params: SupervisorRegistryUpsertParams): Promise<SupervisorRegistryRow> {
    return this.transport.request("supervisors", "upsert_registry", [params]);
  }
  getSupervisorRegistry(role: string): Promise<SupervisorRegistryRow | null> {
    return this.transport.request("supervisors", "get_registry", [role]);
  }
  listSupervisorRegistries(): Promise<SupervisorRegistryRow[]> {
    return this.transport.request("supervisors", "list_registries", []);
  }
  touchSupervisorRegistry(role: string, lastSeenAt: Date): Promise<SupervisorRegistryRow | null> {
    return this.transport.request("supervisors", "touch_registry", [role, lastSeenAt]);
  }
  recordSupervisorUsageDelta(params: { role: string; tokenDelta: number; compactionDelta?: number; lastSeenAt?: Date | null }): Promise<SupervisorRegistryRow> {
    return this.transport.request("supervisors", "record_usage_delta", [params]);
  }
  deleteSupervisorRegistry(role: string): Promise<boolean> {
    return this.transport.request("supervisors", "delete_registry", [role]);
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

function snakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), snakeCase(child)]));
}

function reviveDates(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map(child => reviveDates(child));
  if (typeof value === "string" && key !== "daily_date" && /(?:_at|At|_before|Before|_expires_at)$/.test(key ?? "")) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : value;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [childKey, reviveDates(child, childKey)]));
}
