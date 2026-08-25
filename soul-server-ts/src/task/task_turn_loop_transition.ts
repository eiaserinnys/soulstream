import type { AgentProfile } from "../agent_registry.js";
import { formatContextItems } from "../context/prompt_assembler.js";
import type { SupportsDetachedClaudeRuntime } from "../engine/protocol.js";

import { appendAttachmentPathNotes } from "./attachment_path_note.js";
import { splitAttachmentPaths } from "./attachment_context.js";
import { hasPendingClaudeRuntimeWork } from "./claude_runtime_state.js";
import { dequeueInterventions } from "./task_intervention_queue.js";
import type { Task, InterventionMessage } from "./task_models.js";
import { effectiveTaskBackend } from "./task_model_preset.js";

export type TurnLoopTransitionDecision =
  | { kind: "stop" }
  | { kind: "awaiting_approval" }
  | { kind: "awaiting_runtime" }
  | {
      kind: "continue";
      prompt: string;
      imageAttachmentPaths: string[];
      interventions: InterventionMessage[];
    };

export function resolveTurnLoopTransition(
  task: Task,
  agent: AgentProfile,
): TurnLoopTransitionDecision {
  if (task.status !== "running") {
    return { kind: "stop" };
  }
  if (
    effectiveTaskBackend(task, agent) === "openai-agents"
    && isOpenAiAgentsApprovalPending(task)
  ) {
    return { kind: "awaiting_approval" };
  }
  if (hasPendingClaudeRuntimeWork(task) && !hasDetachedClaudeRuntime(task)) {
    return { kind: "awaiting_runtime" };
  }

  const next = dequeueInterventions(task);
  if (next.length === 0) {
    task.status = "completed";
    return { kind: "stop" };
  }

  const composed = composeInterventionTurnPrompt(next);
  return {
    kind: "continue",
    prompt: composed.prompt,
    imageAttachmentPaths: composed.imageAttachmentPaths,
    interventions: next,
  };
}

function hasDetachedClaudeRuntime(task: Task): boolean {
  const engine = task.runner?.engine as
    | (NonNullable<Task["runner"]>["engine"] & Partial<SupportsDetachedClaudeRuntime>)
    | undefined;
  return engine?.detachedClaudeRuntime === true;
}

export function isOpenAiAgentsApprovalPending(task: Task): boolean {
  return Boolean(
    task.status === "running" &&
      task.agentsRunState &&
      task.agentsPendingApprovalId,
  );
}

export function composeInterventionTurnPrompt(messages: readonly InterventionMessage[]): {
  prompt: string;
  imageAttachmentPaths: string[];
} {
  const prompts: string[] = [];
  const imageAttachmentPaths: string[] = [];
  for (const message of messages) {
    const { imagePaths } = splitAttachmentPaths(message.attachmentPaths);
    imageAttachmentPaths.push(...imagePaths);
    const contextBlock = formatContextItems(message.context ?? []);
    const text = appendAttachmentPathNotes(message.text, message.attachmentPaths);
    prompts.push(contextBlock ? `${contextBlock}\n\n${text}` : text);
  }
  return {
    prompt: prompts.join("\n\n"),
    imageAttachmentPaths,
  };
}
