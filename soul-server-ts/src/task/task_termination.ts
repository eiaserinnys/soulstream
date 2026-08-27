import type {
  PendingTerminationHint,
  Task,
  TerminationReason,
} from "./task_models.js";

const HINT_PRECEDENCE: Record<PendingTerminationHint, number> = {
  error_aborted: 1,
  limit_hit: 2,
  killed: 3,
};

export interface TerminationResolution {
  reason: TerminationReason;
  detail: string | null;
  newlyFinalized: boolean;
}

export function recordTerminationHint(
  task: Task,
  reason: PendingTerminationHint,
  detail?: string | null,
): void {
  if (task.terminationReason) return;
  const current = task.pendingTerminationHint;
  if (current && HINT_PRECEDENCE[current] > HINT_PRECEDENCE[reason]) {
    return;
  }
  task.pendingTerminationHint = reason;
  task.pendingTerminationDetail = normalizeDetail(detail);
}

export function finalizeTaskTermination(task: Task): TerminationResolution {
  if (task.terminationReason || task.terminationEventRecorded) {
    const reason = task.terminationReason ?? resolveTerminationReason(task);
    const detail = task.terminationDetail ?? resolveTerminationDetail(task, reason);
    task.terminationReason = reason;
    task.terminationDetail = detail;
    return {
      reason,
      detail,
      newlyFinalized: false,
    };
  }

  const reason = resolveTerminationReason(task);
  const detail = resolveTerminationDetail(task, reason);
  task.terminationReason = reason;
  task.terminationDetail = detail;
  return { reason, detail, newlyFinalized: true };
}

export function buildSessionEndedEvent(task: Task): {
  type: "session_ended";
  status: Task["status"];
  termination_reason: TerminationReason;
  termination_detail: string | null;
  timestamp: number;
  _dedupe_key: string;
} {
  return {
    type: "session_ended",
    status: task.status,
    termination_reason: task.terminationReason ?? "unknown",
    termination_detail: task.terminationDetail ?? null,
    timestamp: Math.floor((task.completedAt ?? new Date()).getTime() / 1000),
    _dedupe_key: terminalDedupeKey(task),
  };
}

function terminalDedupeKey(task: Task): string {
  const ownership = task.executionOwnership;
  const recovered = task.recoveredExecutionOwnership;
  const completedAt = task.completedAt ?? task.createdAt;
  const transitionIdentity = [
    ownership && `generation:${ownership.ownershipGeneration}`,
    recovered
      && `runner:${recovered.registrationId}:${recovered.executionCommandId ?? "legacy"}`,
    `completed_at:${completedAt.toISOString()}`,
  ].find(Boolean);
  return `session_terminal:${task.agentSessionId}:${String(transitionIdentity)}`;
}

function resolveTerminationReason(task: Task): TerminationReason {
  if (task.status === "completed") return "completed_ok";
  if (task.pendingTerminationHint) return task.pendingTerminationHint;
  return "unknown";
}

function resolveTerminationDetail(
  task: Task,
  reason: TerminationReason,
): string | null {
  if (reason === "completed_ok") return null;
  if (task.pendingTerminationDetail) return task.pendingTerminationDetail;
  if (reason === "error_aborted" && task.error) return task.error;
  return null;
}

function normalizeDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  const trimmed = detail.trim();
  return trimmed.length > 0 ? trimmed : null;
}
