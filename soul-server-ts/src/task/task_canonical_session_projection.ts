import type { EventCanonicalSessionProjection } from
  "../upstream/event_outbox_pump.js";

import type {
  ReviewState,
  Task,
} from "./task_models.js";
import {
  isTaskStatus,
  isTerminationReason,
  isTerminalTaskStatus,
} from "./task_models.js";

const REVIEW_STATES = new Set<ReviewState>([
  "not_required",
  "needs_review",
  "acknowledged",
]);
/** Reconciles the node-local Task cache with the canonical orch session row. */
export function applyCanonicalSessionProjection(
  task: Task,
  session: EventCanonicalSessionProjection,
): void {
  const status = session.status;
  const terminationReason = session.termination_reason;
  if (!isTaskStatus(status)) {
    throw new Error(`canonical session has invalid status: ${session.status}`);
  }
  if (!REVIEW_STATES.has(session.review_state as ReviewState)) {
    throw new Error(`canonical session has invalid review state: ${session.review_state}`);
  }
  if (
    terminationReason !== null
    && !isTerminationReason(terminationReason)
  ) {
    throw new Error(
      `canonical session has invalid termination reason: ${session.termination_reason}`,
    );
  }
  const updatedAt = new Date(session.updated_at);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new Error("canonical session has invalid updated_at");
  }

  task.status = status;
  task.reviewState = session.review_state as ReviewState;
  task.lastAssistantText = session.last_assistant_text ?? undefined;
  task.lastEventId = session.last_event_id ?? task.lastEventId;
  task.terminalEventId = session.termination_event_id ?? undefined;
  task.terminationEventRecorded = session.termination_event_id !== null;
  task.terminationReason = terminationReason ?? undefined;
  task.terminationDetail = terminationReason === null
    ? undefined
    : session.termination_detail;
  task.completedAt = isTerminalTaskStatus(status)
    ? updatedAt
    : undefined;
}
