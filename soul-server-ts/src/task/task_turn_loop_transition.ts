import type { AgentProfile } from "../agent_registry.js";
import type { InputMaterialPartV1 } from "@soulstream/wire-schema";
import { formatContextItemsWithMaterial } from "../context/prompt_assembler.js";
import {
  createInputMaterialPart,
  joinInputMaterialSegments,
  scopeFormattedContextParts,
  type InputMaterialTextSegment,
} from "../context/input_material_parts.js";
import type { SupportsDetachedClaudeRuntime } from "../engine/protocol.js";

import { appendAttachmentPathNotes } from "./attachment_path_note.js";
import { splitAttachmentPaths } from "./attachment_context.js";
import { hasPendingClaudeRuntimeWork } from "./claude_runtime_state.js";
import { dequeueNextTurnInterventions } from "./task_intervention_queue.js";
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

  const next = dequeueNextTurnInterventions(task);
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
  inputMaterialParts: InputMaterialPartV1[];
} {
  const prompts: InputMaterialTextSegment[] = [];
  const imageAttachmentPaths: string[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    const { imagePaths } = splitAttachmentPaths(message.attachmentPaths);
    imageAttachmentPaths.push(...imagePaths);
    const context = formatContextItemsWithMaterial(message.context ?? []);
    const text = appendAttachmentPathNotes(message.text, message.attachmentPaths);
    const user = {
      text,
      parts: [createInputMaterialPart(
        "user_prompt",
        `intervention/${messageIndex}/user`,
        text,
      )],
    };
    prompts.push(context.text
      ? joinInputMaterialSegments([
          {
            text: context.text,
            parts: scopeFormattedContextParts(context.parts, `intervention/${messageIndex}`),
          },
          user,
        ], "\n\n", `intervention/${messageIndex}`)
      : user);
  }
  const assembled = joinInputMaterialSegments(prompts, "\n\n", "intervention_batch");
  return {
    prompt: assembled.text,
    imageAttachmentPaths,
    inputMaterialParts: [...assembled.parts],
  };
}
