import type {
  TurnSummaryJob,
} from "../turn-summary/turn_summary_queue.js";

import type { Task } from "./task_models.js";
import type { TaskTurnInput } from "./task_turn_input_builder.js";

export function buildCompletedTurnSummaryJob(
  task: Task,
  input: TaskTurnInput,
  followupStalled: boolean,
): TurnSummaryJob | undefined {
  if (followupStalled || task.status !== "running") return undefined;
  if (!input.summaryInput || task.currentTurnFinalResponseEventId === undefined) {
    return undefined;
  }
  const assistantText = task.lastAssistantText?.trim();
  const userText = input.summaryInput.userText.trim();
  if (!assistantText) return undefined;
  return {
    sessionId: task.agentSessionId,
    userText,
    assistantText,
    turnStartEventId: input.summaryInput.turnStartEventId,
    finalResponseEventId: task.currentTurnFinalResponseEventId,
  };
}
