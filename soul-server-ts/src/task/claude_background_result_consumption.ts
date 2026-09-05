import { readClaudeToolResultReceiptMetadata } from
  "../engine/claude_tool_result_receipt_metadata.js";
import type { SSEEventPayload } from "../engine/protocol.js";

export type ClaudeBackgroundConsumptionProof =
  | {
      kind: "exact_generation";
      taskId: string;
      initiatingToolUseId: string;
    }
  | {
      kind: "task_output";
      taskId: string;
    };

export interface ClaudeToolStartObservation {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
}

const TERMINAL_TASK_OUTPUT_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

/** Classifies only the typed tool-result envelope; rendered output is never input. */
export function classifyClaudeBackgroundConsumptionProof(
  start: ClaudeToolStartObservation,
  event: SSEEventPayload,
): ClaudeBackgroundConsumptionProof | undefined {
  if (event.type !== "tool_result") return undefined;
  const payload = event as Record<string, unknown>;
  if (payload.is_error === true || payload.tool_use_id !== start.toolUseId) {
    return undefined;
  }
  const envelope = readClaudeToolResultReceiptMetadata(event)?.envelope;
  if (!envelope) return undefined;

  if (start.toolName === "Agent" && start.toolInput.run_in_background === true) {
    const taskId = stringField(envelope, "agentId", "agent_id");
    return taskId
      ? {
          kind: "exact_generation",
          taskId,
          initiatingToolUseId: start.toolUseId,
        }
      : undefined;
  }

  if (start.toolName !== "TaskOutput") return undefined;
  const requestedTaskId = stringField(start.toolInput, "task_id", "taskId");
  const returnedTaskId = stringField(envelope, "task_id", "taskId");
  const retrievalStatus = stringField(
    envelope,
    "retrieval_status",
    "retrievalStatus",
  );
  const status = stringField(envelope, "status");
  if (
    !requestedTaskId || returnedTaskId !== requestedTaskId ||
    retrievalStatus !== "success" || !status ||
    !TERMINAL_TASK_OUTPUT_STATUSES.has(status)
  ) {
    return undefined;
  }
  return { kind: "task_output", taskId: requestedTaskId };
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
