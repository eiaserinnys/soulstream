import type { TaskManager } from "./task_manager.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { buildClaudeRuntimeFollowupFallbackDelivery } from
  "./claude_runtime_followup_delivery.js";
import {
  buildClaudeRuntimeTaskFollowupFallbackPrompt,
  buildRefreshedClaudeRuntimeTaskFollowupPrompt,
} from "./claude_runtime_task_followup_prompt.js";

export const CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE = "claude_runtime_task_followup";
export const MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT = 3;
export const CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS: Readonly<Record<number, number>> = {
  2: 5_000,
  3: 30_000,
};

export type ClaudeRuntimeFollowupStallReason =
  | "empty_response"
  | "repeated_response";

export function buildRuntimeFollowupFallback(
  task: Task,
  message: InterventionMessage,
  reason: ClaudeRuntimeFollowupStallReason,
  deliveryV2Enabled: boolean,
): {
  attempt: number;
  followupKey: string;
  delayMs: number;
  fallbackMessage: Parameters<TaskManager["addIntervention"]>[0];
} {
  const attempt = (message.followupAttempt ?? 1) + 1;
  const followupKey = message.followupKey ?? `${task.agentSessionId}:attempt:${attempt}`;
  const refreshedPrompt = buildRefreshedClaudeRuntimeTaskFollowupPrompt(task, message);
  const fallbackText = buildClaudeRuntimeTaskFollowupFallbackPrompt(
    refreshedPrompt ?? message.text,
    reason,
  );
  const fallbackDelivery = deliveryV2Enabled
    ? buildClaudeRuntimeFollowupFallbackDelivery(task, message, {
        text: fallbackText,
        reason,
        attempt,
        followupTaskIds: message.followupTaskIds,
      })
    : {
        deliveryId: message.deliveryId,
        deliveryIntent: message.deliveryIntent,
        completionId: message.completionId,
        relationKey: message.relationKey,
        producerTerminalRevision: message.producerTerminalRevision,
        parentDeliveryId: message.parentDeliveryId,
        callerTurnId: message.callerTurnId,
        deliveryCreatedAt: message.deliveryCreatedAt,
      };
  const delayMs = CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS[attempt];
  if (delayMs === undefined) {
    throw new Error(`No Claude runtime follow-up retry delay configured for attempt ${attempt}`);
  }
  return {
    attempt,
    followupKey,
    delayMs,
    fallbackMessage: {
      agentSessionId: task.agentSessionId,
      text: fallbackText,
      user: "system",
      callerInfo: message.callerInfo ?? { source: "system", display_name: "Soulstream" },
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: attempt,
      followupKey,
      followupTaskIds: message.followupTaskIds,
      ...fallbackDelivery,
      callerTurnId: message.callerTurnId,
    },
  };
}
