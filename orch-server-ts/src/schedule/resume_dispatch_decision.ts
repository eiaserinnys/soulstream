/**
 * Whether a due ResumeAfterLimit reservation should wake its session is a
 * store-owned decision: the schedule row, the session row and the limit-window
 * history live here, and only the node knows whether its local task is busy.
 *
 * Keeping the cells here (instead of in the node dispatcher) is what lets an
 * old worker and a new worker agree on the same reservation while they are
 * rolled independently.
 */

export interface ResumeDispatchSessionRow {
  status: string;
  terminationReason: string | null;
  terminalEventId: number | null;
}

export interface ResumeDispatchFacts {
  /** Parsed from the reservation identity. Null means the row cannot be trusted. */
  originalTerminalEventId: number | null;
  session: ResumeDispatchSessionRow | null;
  /** Resets window and terminal chain still belong to the reservation's limit. */
  continuousLimitWindow: boolean;
  /** The node is already launching or running this session's local task. */
  localTaskBusy: boolean;
}

export type ResumeDispatchDecision =
  | { decision: "fire"; reason: null }
  | { decision: "defer"; reason: string }
  | { decision: "close"; reason: string };

export function decideResumeDispatch(
  facts: ResumeDispatchFacts,
): ResumeDispatchDecision {
  if (facts.originalTerminalEventId === null) {
    return { decision: "close", reason: "invalid_original_revision" };
  }
  // A busy local task is a transient state: the launch in progress may still
  // restore the limit terminal (compensation), so closing here would strand the
  // reservation. Wait for that launch to settle before judging the session row.
  if (facts.localTaskBusy) {
    return { decision: "defer", reason: "local_task_busy" };
  }
  const session = facts.session;
  if (session === null) {
    return { decision: "close", reason: "session_missing" };
  }
  if (session.status === "initializing" || session.status === "running") {
    return { decision: "close", reason: "session_already_awake" };
  }
  if (session.status !== "error" || session.terminationReason !== "limit_hit") {
    return { decision: "close", reason: "current_session_not_limit_hit" };
  }
  if (
    typeof session.terminalEventId !== "number"
    || !Number.isSafeInteger(session.terminalEventId)
    || session.terminalEventId <= 0
  ) {
    return { decision: "close", reason: "missing_current_revision" };
  }
  if (!facts.continuousLimitWindow) {
    return { decision: "close", reason: "limit_window_or_terminal_chain_changed" };
  }
  return { decision: "fire", reason: null };
}
