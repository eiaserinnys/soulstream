import type { AgentProfile } from "@soulstream/agent-profile-contract";
import { effectiveTaskBackend } from "./task_model_preset.js";
import type { Task } from "./task_models.js";

export const ANTIGRAVITY_LEGACY_RESUME = "antigravity_legacy_resume";
export const ANTIGRAVITY_DEFAULT_CONVERSATION = "antigravity_default_conversation";

export function antigravityDefaultConversation(task: Task): string | undefined {
  const value = task.metadata?.find(item => item.type === ANTIGRAVITY_DEFAULT_CONVERSATION)?.value;
  return typeof value === "string" ? value : undefined;
}

export function prepareAntigravityResume(task: Task, agent: AgentProfile, workspace?: { conversationId?: string; instructionsPresent: boolean }): void {
  if (effectiveTaskBackend(task, agent) !== "antigravity" || !task.codexThreadId || task.persistentGeneration?.pending) return;
  if (antigravityDefaultConversation(task) === task.codexThreadId || workspace?.conversationId === task.codexThreadId) {
    if (!workspace?.instructionsPresent) task.needsFullContextReinjection = true;
    return;
  }
  const generation = task.persistentGeneration ?? { number: 1 };
  task.persistentGeneration = {
    ...generation,
    pending: {
      number: generation.number + 1,
      reason: ANTIGRAVITY_LEGACY_RESUME,
      requestedAt: new Date().toISOString(),
      targetModelPreset: task.modelPreset ?? "",
      ...(task.reasoningEffort === undefined ? {} : { targetReasoningEffort: task.reasoningEffort }),
    },
  };
}
