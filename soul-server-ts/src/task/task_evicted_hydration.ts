import type { Logger } from "pino";

import type { SessionDB, SessionRow } from "../db/session_db.js";
import {
  TaskHydrationFailedError,
  TaskOwnedByAnotherNodeError,
} from "./task_hydration_errors.js";
import type { ExecutionOwnershipToken } from "./execution_ownership.js";
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

function executionOwnershipFromRow(
  row: SessionRow,
  logger: Logger,
): ExecutionOwnershipToken | null | undefined {
  const ownerFields = [
    row.execution_generation,
    row.execution_manifest_id,
    row.execution_runtime_env_identity,
    row.execution_registration_id,
    row.execution_pid,
    row.execution_start_identity,
    row.execution_command_id,
    row.execution_lease_expires_at,
  ];
  if (ownerFields.every((value) => value == null)) return undefined;

  const ownershipGeneration = Number(row.execution_generation);
  const leaseExpiresAt = row.execution_lease_expires_at instanceof Date
    ? row.execution_lease_expires_at
    : new Date(row.execution_lease_expires_at ?? Number.NaN);
  const complete = Number.isSafeInteger(ownershipGeneration)
    && ownershipGeneration > 0
    && typeof row.execution_manifest_id === "string"
    && row.execution_manifest_id.length > 0
    && typeof row.execution_runtime_env_identity === "string"
    && row.execution_runtime_env_identity.length > 0
    && typeof row.execution_registration_id === "string"
    && row.execution_registration_id.length > 0
    && Number.isSafeInteger(row.execution_pid)
    && row.execution_pid! > 0
    && typeof row.execution_start_identity === "string"
    && row.execution_start_identity.length > 0
    && typeof row.execution_command_id === "string"
    && row.execution_command_id.length > 0
    && Number.isFinite(leaseExpiresAt.getTime());
  if (!complete) {
    logger.warn(
      {
        sessionId: row.session_id,
        ownershipGeneration: row.execution_generation ?? null,
        hasManifestId: Boolean(row.execution_manifest_id),
        hasRuntimeEnvIdentity: Boolean(row.execution_runtime_env_identity),
        hasRegistrationId: Boolean(row.execution_registration_id),
        hasPid: row.execution_pid != null,
        hasStartIdentity: Boolean(row.execution_start_identity),
        hasExecutionCommandId: Boolean(row.execution_command_id),
        hasLease: row.execution_lease_expires_at != null,
      },
      "loadEvictedTask: partial sessions-row execution owner",
    );
    return null;
  }

  return {
    ownerKind: "runner_process",
    manifestId: row.execution_manifest_id!,
    runtimeEnvIdentity: row.execution_runtime_env_identity!,
    registrationId: row.execution_registration_id!,
    pid: row.execution_pid!,
    startIdentity: row.execution_start_identity!,
    executionCommandId: row.execution_command_id!,
    ownershipGeneration,
  };
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
  const executionOwnership = executionOwnershipFromRow(row, logger);
  if (executionOwnership === null) return null;

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
    ...(executionOwnership === undefined ? {} : { executionOwnership }),
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
