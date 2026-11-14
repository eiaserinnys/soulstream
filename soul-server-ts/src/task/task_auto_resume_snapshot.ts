import {
  isTerminalTaskStatus,
  type Task,
  type TaskStatus,
  type TerminationReason,
} from "./task_models.js";

/** 자동 재개가 종료 상태를 되돌릴 때 쓰는 순수 보조: 종료 스냅샷과 caller_info 비교. */
export interface TerminalResumeSnapshot {
  status: Extract<TaskStatus, "completed" | "error" | "interrupted">;
  terminationReason: TerminationReason;
  terminationDetail: string | null;
  reviewState: NonNullable<Task["reviewState"]>;
  lastAssistantText: string | null;
  result: string | undefined;
  error: string | undefined;
  pendingTerminationHint: Task["pendingTerminationHint"];
  pendingTerminationDetail: Task["pendingTerminationDetail"];
}

export function captureTerminalResumeSnapshot(
  task: Task,
  status: TerminalResumeSnapshot["status"],
): TerminalResumeSnapshot {
  return {
    status,
    terminationReason: task.terminationReason
      ?? (status === "completed" ? "completed_ok" : "unknown"),
    terminationDetail: task.terminationDetail ?? null,
    reviewState: task.reviewState ?? "not_required",
    lastAssistantText: task.lastAssistantText ?? null,
    result: task.result,
    error: task.error,
    pendingTerminationHint: task.pendingTerminationHint,
    pendingTerminationDetail: task.pendingTerminationDetail,
  };
}

export function findLastCallerInfoMetadataEntry(
  metadata: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    const entry = metadata[index];
    if (entry?.type === "caller_info") return entry;
  }
  return undefined;
}

export function stableSerialize(value: unknown): string {
  const serialized = JSON.stringify(sortJsonKeys(value));
  if (serialized === undefined) {
    throw new Error("caller_info metadata entry is not JSON serializable");
  }
  return serialized;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortJsonKeys(entry)]),
  );
}
