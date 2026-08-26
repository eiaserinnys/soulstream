import type { Logger } from "pino";

import type { SessionDB, SessionRow } from "../db/session_db.js";
import {
  TaskHydrationFailedError,
  TaskOwnedByAnotherNodeError,
} from "./task_hydration_errors.js";
import type { Task, TaskStatus, TerminationReason } from "./task_models.js";
import {
  extractAgentsRunStateFromMetadata,
  extractAgentsSessionItemsFromMetadata,
  extractCallerInfoFromMetadata,
  extractClaudeBackendRolloverState,
  extractClaudePermissionModeFromMetadata,
} from "./task_metadata.js";

const VALID_TASK_STATUSES: readonly TaskStatus[] = [
  "initializing",
  "running",
  "completed",
  "error",
  "interrupted",
];

const VALID_TERMINATION_REASONS: readonly TerminationReason[] = [
  "completed_ok",
  "killed",
  "limit_hit",
  "error_aborted",
  "unknown",
];

function isTaskStatus(status: string | null): status is TaskStatus {
  return Boolean(status && VALID_TASK_STATUSES.includes(status as TaskStatus));
}

function completedAtFromRow(row: SessionRow, status: TaskStatus): Date | undefined {
  if (status === "completed" || status === "error" || status === "interrupted") {
    return row.updated_at ?? undefined;
  }
  return undefined;
}

function terminationReasonFromRow(value: string | null | undefined): TerminationReason | undefined {
  return value && VALID_TERMINATION_REASONS.includes(value as TerminationReason)
    ? value as TerminationReason
    : undefined;
}

function terminalStatusFromReason(reason: TerminationReason): TaskStatus {
  if (reason === "completed_ok") return "completed";
  if (reason === "killed") return "interrupted";
  return "error";
}

function positiveEventId(value: number | null | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value! : undefined;
}

/**
 * Reconstructs a runtime Task from the persisted sessions row used by lazy hydration.
 *
 * This mapper owns SessionRow shape, status validation, metadata restoration,
 * and Task field defaults.
 */
export function hydrateEvictedTaskFromSessionRow(
  row: SessionRow,
  logger: Logger,
): Task | null {
  const status = row.status;
  if (!isTaskStatus(status)) {
    logger.warn(
      { sessionId: row.session_id, status, createdAt: row.created_at },
      "loadEvictedTask: incomplete or invalid SessionRow",
    );
    return null;
  }

  const metadata = Array.isArray(row.metadata)
    ? (row.metadata as Array<Record<string, unknown>>)
    : [];
  const agentsRunState = extractAgentsRunStateFromMetadata(metadata);
  const agentsSessionItems = extractAgentsSessionItemsFromMetadata(metadata);
  const claudePermissionMode = extractClaudePermissionModeFromMetadata(metadata);
  const terminationReason = terminationReasonFromRow(row.termination_reason);
  const terminalEventId = positiveEventId(row.termination_event_id);
  if (row.termination_reason != null && terminationReason === undefined) {
    logger.warn(
      { sessionId: row.session_id, terminationReason: row.termination_reason },
      "loadEvictedTask: invalid durable termination reason",
    );
    return null;
  }
  if (row.termination_event_id != null && terminalEventId === undefined) {
    logger.warn(
      { sessionId: row.session_id, terminalEventId: row.termination_event_id },
      "loadEvictedTask: invalid durable terminal event id",
    );
    return null;
  }
  const hydratedStatus = terminationReason === undefined
    ? status
    : terminalStatusFromReason(terminationReason);

  const claudeBackendRollover = extractClaudeBackendRolloverState(metadata);
  const rolloverCycleFrom = claudeBackendRollover.phase === "pending"
    ? claudeBackendRollover.previousSessionId
    : undefined;
  return {
    agentSessionId: row.session_id,
    prompt: row.prompt ?? "",
    status: hydratedStatus,
    reviewRequired: row.review_required === true,
    reviewState: row.review_state ?? "not_required",
    hydratedFromDb: true,
    profileId: row.agent_id ?? undefined,
    clientId: row.client_id,
    sessionType: row.session_type === "llm" ? "llm" : "claude",
    codexThreadId: row.claude_session_id ?? undefined,
    callerSessionId: row.caller_session_id ?? undefined,
    callerInfo: extractCallerInfoFromMetadata(row.metadata),
    notifyCompletion: row.notify_completion !== false,
    metadata,
    agentsRunState: agentsRunState?.serialized,
    agentsRunStateSchemaVersion: agentsRunState?.schemaVersion,
    agentsPendingApprovalId: agentsRunState?.pendingApprovalId,
    agentsPreviousResponseId: agentsRunState?.previousResponseId,
    agentsConversationId: agentsRunState?.conversationId,
    agentsSessionItems,
    claudePermissionMode,
    claudeBackendRolloverAttempts: claudeBackendRollover.attempts,
    ...(rolloverCycleFrom === undefined
      ? {}
      : { claudeBackendRolloverCycleFrom: rolloverCycleFrom }),
    ...(rolloverCycleFrom !== undefined && row.claude_session_id === rolloverCycleFrom
      ? { pendingClaudeBackendRolloverFrom: rolloverCycleFrom }
      : {}),
    modelPreset: row.model_preset,
    model: row.model,
    createdAt: row.created_at,
    completedAt: completedAtFromRow(row, hydratedStatus),
    lastAssistantText: row.last_assistant_text ?? undefined,
    terminationReason,
    terminationDetail: terminationReason ? row.termination_detail : undefined,
    terminationEventRecorded: terminalEventId !== undefined,
    terminalEventId,
    lastEventId: row.last_event_id ?? 0,
    lastReadEventId: row.last_read_event_id ?? 0,
    interventionQueue: [],
  };
}

export function createEvictedTaskLoader(input: {
  db: SessionDB;
  logger: Logger;
  nodeId: string;
}): (sessionId: string) => Promise<Task | null> {
  return async (sessionId) => {
    let row: SessionRow | null;
    try {
      row = await input.db.getSession(sessionId);
    } catch (err) {
      input.logger.warn({ err, sessionId }, "loadEvictedTask: getSession failed");
      throw new TaskHydrationFailedError(sessionId, err);
    }
    if (!row) return null;
    if (row.node_id && row.node_id !== input.nodeId) {
      input.logger.info(
        {
          sessionId,
          ownerNodeId: row.node_id,
          currentNodeId: input.nodeId,
        },
        "loadEvictedTask: session belongs to another node",
      );
      throw new TaskOwnedByAnotherNodeError(sessionId, row.node_id, input.nodeId);
    }
    return hydrateEvictedTaskFromSessionRow(row, input.logger);
  };
}
