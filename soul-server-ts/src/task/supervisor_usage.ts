import type { SSEEventPayload } from "../engine/protocol.js";

import type { Task } from "./task_models.js";

export interface SupervisorUsageDelta {
  tokenDelta: number;
  compactionDelta: number;
}

export function supervisorUsageDeltaForEvent(
  task: Task,
  event: SSEEventPayload,
): SupervisorUsageDelta {
  const eventType = (event as { type: string }).type;
  if (eventType === "compact") {
    resetUsageSlot(task, "context_usage");
    return { tokenDelta: 0, compactionDelta: 1 };
  }
  if (eventType === "context_usage") {
    const total = firstNumber(event as Record<string, unknown>, [
      "used_tokens",
      "usedTokens",
      "total_tokens",
      "totalTokens",
    ]);
    return {
      tokenDelta: deltaForSlot(task, "context_usage", total),
      compactionDelta: 0,
    };
  }
  if (eventType !== "complete") {
    return { tokenDelta: 0, compactionDelta: 0 };
  }

  const total = usageTokenTotal((event as { usage?: unknown }).usage);
  return {
    tokenDelta: deltaForSlot(task, usageSlotForComplete(event), total),
    compactionDelta: 0,
  };
}

export function usageTokenTotal(usage: unknown): number {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const record = usage as Record<string, unknown>;
  return (
    firstNumber(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]) +
    firstNumber(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]) +
    firstNumber(record, ["cache_creation_input_tokens", "cacheCreationInputTokens"]) +
    firstNumber(record, ["cache_read_input_tokens", "cacheReadInputTokens"])
  );
}

function usageSlotForComplete(event: SSEEventPayload): string {
  const record = event as Record<string, unknown>;
  if (typeof record.turn_id === "string" && record.turn_id) {
    return `turn:${record.turn_id}`;
  }
  const eventId = record._event_id;
  if (typeof eventId === "number" && Number.isFinite(eventId) && eventId > 0) {
    return `event:${Math.trunc(eventId)}`;
  }
  return "complete:ephemeral";
}

function deltaForSlot(task: Task, slot: string, nextTotal: number): number {
  if (nextTotal <= 0) return 0;
  task.supervisorUsageTotals ??= {};
  const previousTotal = task.supervisorUsageTotals[slot] ?? 0;
  task.supervisorUsageTotals[slot] = Math.max(previousTotal, nextTotal);
  return Math.max(0, nextTotal - previousTotal);
}

function resetUsageSlot(task: Task, slot: string): void {
  task.supervisorUsageTotals ??= {};
  task.supervisorUsageTotals[slot] = 0;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}
