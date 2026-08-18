import type { EventCanonicalSessionProjection } from
  "../upstream/event_outbox_pump.js";

import type {
  ReviewState,
  Task,
  TaskStatus,
  TerminationReason,
} from "./task_models.js";
import { isTerminalTaskStatus } from "./task_models.js";

const TASK_STATUSES = new Set<TaskStatus>([
  "initializing",
  "running",
  "completed",
  "error",
  "interrupted",
]);
const REVIEW_STATES = new Set<ReviewState>([
  "not_required",
  "needs_review",
  "acknowledged",
]);
const TERMINATION_REASONS = new Set<TerminationReason>([
  "completed_ok",
  "killed",
  "limit_hit",
  "error_aborted",
  "unknown",
]);

/** Reconciles the node-local Task cache with the canonical orch session row. */
export function applyCanonicalSessionProjection(
  task: Task,
  session: EventCanonicalSessionProjection,
): void {
  if (!TASK_STATUSES.has(session.status as TaskStatus)) {
    throw new Error(`canonical session has invalid status: ${session.status}`);
  }
  if (!REVIEW_STATES.has(session.review_state as ReviewState)) {
    throw new Error(`canonical session has invalid review state: ${session.review_state}`);
  }
  if (
    session.termination_reason !== null
    && !TERMINATION_REASONS.has(session.termination_reason as TerminationReason)
  ) {
    throw new Error(
      `canonical session has invalid termination reason: ${session.termination_reason}`,
    );
  }
  const updatedAt = new Date(session.updated_at);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new Error("canonical session has invalid updated_at");
  }

  task.status = session.status as TaskStatus;
  task.reviewState = session.review_state as ReviewState;
  task.lastAssistantText = session.last_assistant_text ?? undefined;
  task.lastEventId = session.last_event_id ?? task.lastEventId;
  task.terminalEventId = session.termination_event_id ?? undefined;
  task.terminationEventRecorded = session.termination_event_id !== null;
  task.terminationReason = session.termination_reason as TerminationReason | null
    ?? undefined;
  task.terminationDetail = session.termination_reason === null
    ? undefined
    : session.termination_detail;
  task.completedAt = isTerminalTaskStatus(session.status as TaskStatus)
    ? updatedAt
    : undefined;
}
