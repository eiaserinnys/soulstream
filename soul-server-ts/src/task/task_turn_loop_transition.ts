import type { AgentProfile } from "../agent_registry.js";
import { formatContextItems } from "../context/prompt_assembler.js";

import { appendAttachmentPathNotes } from "./attachment_path_note.js";
import { splitAttachmentPaths } from "./attachment_context.js";
import { hasPendingClaudeRuntimeWork } from "./claude_runtime_state.js";
import type { Task, InterventionMessage } from "./task_models.js";

export type TurnLoopTransitionDecision =
  | { kind: "stop" }
  | { kind: "awaiting_approval" }
  | { kind: "awaiting_runtime" }
  | {
      kind: "continue";
      prompt: string;
      imageAttachmentPaths: string[];
      intervention: InterventionMessage;
    };

export function resolveTurnLoopTransition(
  task: Task,
  agent: AgentProfile,
): TurnLoopTransitionDecision {
  if (task.status !== "running") {
    return { kind: "stop" };
  }
  if (agent.backend === "openai-agents" && isOpenAiAgentsApprovalPending(task)) {
    return { kind: "awaiting_approval" };
  }
  if (hasPendingClaudeRuntimeWork(task)) {
    return { kind: "awaiting_runtime" };
  }

  const next = task.interventionQueue.shift();
  if (!next) {
    task.status = "completed";
    return { kind: "stop" };
  }

  const composed = composeInterventionTurnPrompt(next);
  return {
    kind: "continue",
    prompt: composed.prompt,
    imageAttachmentPaths: composed.imageAttachmentPaths,
    intervention: next,
  };
}

export function isOpenAiAgentsApprovalPending(task: Task): boolean {
  return Boolean(
    task.status === "running" &&
      task.agentsRunState &&
      task.agentsPendingApprovalId,
  );
}

export function composeInterventionTurnPrompt(message: InterventionMessage): {
  prompt: string;
  imageAttachmentPaths: string[];
} {
  const { imagePaths } = splitAttachmentPaths(message.attachmentPaths);
  const contextItems = message.context ?? [];
  const contextBlock = formatContextItems(contextItems);
  const text = appendAttachmentPathNotes(message.text, message.attachmentPaths);
  return {
    prompt: contextBlock ? `${contextBlock}\n\n${text}` : text,
    imageAttachmentPaths: imagePaths,
  };
}
