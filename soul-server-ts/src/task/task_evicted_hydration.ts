import type { Logger } from "pino";

import type { SessionRow } from "../db/session_db.js";
import type { Task, TaskStatus } from "./task_models.js";
import {
  extractAgentsRunStateFromMetadata,
  extractAgentsSessionItemsFromMetadata,
  extractCallerInfoFromMetadata,
} from "./task_metadata.js";

const VALID_TASK_STATUSES: readonly TaskStatus[] = [
  "running",
  "completed",
  "error",
  "interrupted",
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

/**
 * Reconstructs a runtime Task from the persisted sessions row used by lazy hydration.
 *
 * TaskManager owns DB lookup and caller routing; this mapper owns SessionRow shape,
 * status validation, metadata restoration, and Task field defaults.
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

  return {
    agentSessionId: row.session_id,
    prompt: row.prompt ?? "",
    status,
    hydratedFromDb: true,
    profileId: row.agent_id ?? undefined,
    clientId: row.client_id,
    sessionType: row.session_type === "llm" ? "llm" : "claude",
    codexThreadId: row.claude_session_id ?? undefined,
    callerSessionId: row.caller_session_id ?? undefined,
    callerInfo: extractCallerInfoFromMetadata(row.metadata),
    metadata,
    agentsRunState: agentsRunState?.serialized,
    agentsRunStateSchemaVersion: agentsRunState?.schemaVersion,
    agentsPendingApprovalId: agentsRunState?.pendingApprovalId,
    agentsPreviousResponseId: agentsRunState?.previousResponseId,
    agentsConversationId: agentsRunState?.conversationId,
    agentsSessionItems,
    createdAt: row.created_at,
    completedAt: completedAtFromRow(row, status),
    lastEventId: row.last_event_id ?? 0,
    lastReadEventId: row.last_read_event_id ?? 0,
    interventionQueue: [],
  };
}
