import type { AgentProfile } from "../agent_registry.js";
import type { BackendRolloverContext, GenerationPreparedContext } from "../context/context_builder.js";
import type { InputMaterialPartV1 } from "@soulstream/wire-schema";
import { composeFirstTurnPromptWithMaterial } from "../context/context_builder.js";
import { formatContextItems } from "../context/prompt_assembler.js";
import {
  createInputMaterialPart,
  inputMaterialPartsMatchText,
} from "../context/input_material_parts.js";

import { appendAttachmentPathNotes } from "./attachment_path_note.js";
import { truncateClaudeTextToEstimatedTokens } from "./claude_context_recovery.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { effectiveTaskBackend } from "./task_model_preset.js";
import type { TaskTurnInput } from "./task_turn_input_builder.js";
import {
  stripManagedAttachmentPathNotes,
  type AttachmentTurnSource,
} from "./prepare_attachment_input.js";
import { interventionTurnOrigin } from "./turn_origin.js";

const CLAUDE_ROLLOVER_REPLAY_INPUT_MAX_CHARS = 40_000;
const CLAUDE_ROLLOVER_CONTEXT_MAX_CHARS = 20_000;
const CLAUDE_ROLLOVER_HISTORY_BLOCK_MAX_CHARS = 14_000;

export interface BackendRolloverReplayBase {
  prompt: string;
  imageAttachmentPaths: string[];
  attachmentNotePaths?: string[];
}

export function createTaskAttachmentSource(task: Task): AttachmentTurnSource | undefined {
  return createAttachmentSource(
    task.agentSessionId,
    task.prompt,
    task.attachmentIds,
    task.attachmentPaths,
    task.attachmentBindings,
    task.executionRegistration?.executionCommandId,
  );
}

export function createInterventionAttachmentSource(
  sessionId: string,
  message: InterventionMessage,
): AttachmentTurnSource | undefined {
  return createAttachmentSource(
    sessionId,
    message.text,
    message.attachmentIds,
    message.attachmentPaths,
    message.attachmentBindings,
    message.deliveryId,
  );
}

export function copyAttachmentSource(source: AttachmentTurnSource): AttachmentTurnSource {
  return {
    ...source,
    ...(source.attachmentIds === undefined ? {} : { attachmentIds: [...source.attachmentIds] }),
    ...(source.attachmentPaths === undefined ? {} : { attachmentPaths: [...source.attachmentPaths] }),
    ...(source.attachmentBindings === undefined
      ? {}
      : { attachmentBindings: source.attachmentBindings.map((binding) => ({ ...binding })) }),
  };
}

export function composeBackendRolloverInterventions(
  interventions: readonly InterventionMessage[],
): BackendRolloverReplayBase {
  const prompts: string[] = [];
  const imageAttachmentPaths: string[] = [];
  const attachmentNotePaths: string[] = [];
  for (const message of interventions) {
    const currentMessage = {
      ...message,
      context: message.context?.filter((item) => item.key !== "assigned_cards"),
    };
    const composed = composeInterventionTurnPrompt([currentMessage]);
    imageAttachmentPaths.push(...composed.imageAttachmentPaths);
    if ((message.attachmentIds?.length ?? 0) > 0) {
      const textOnly = composeInterventionTurnPrompt([{ ...currentMessage, attachmentPaths: [] }]);
      prompts.push(textOnly.prompt);
      attachmentNotePaths.push(...(message.attachmentPaths ?? []));
    } else {
      prompts.push(composed.prompt);
    }
  }
  return {
    prompt: prompts.join("\n\n"),
    imageAttachmentPaths,
    attachmentNotePaths,
  };
}

export function buildBoundedBackendRolloverPrompt(
  replayPrompt: string,
  context: BackendRolloverContext,
  limits: { maxChars: number; maxEstimatedTokens: number },
  attachmentNotePaths: readonly string[] = [],
): string {
  const excerpt = context.currentSessionExcerpt;
  const includedTurns = excerpt?.turns.length ?? 0;
  const coverage = excerpt
    ? `${includedTurns.toLocaleString("en-US")} recent conversation records were carried from `
      + `${excerpt.totalEvents.toLocaleString("en-US")} total session events; `
      + "older or omitted context may be missing."
    : "No prior conversation excerpt was available; all backend-only conversation context "
      + "may be missing.";
  const notice = [
    "<claude_backend_rollover>",
    "The previous Claude backend session exceeded its context window and was replaced.",
    coverage,
    "Before making irreversible changes, re-check the current task, files, and external state.",
    "</claude_backend_rollover>",
  ].join("\n");
  const history = excerpt && excerpt.turns.length > 0
    ? truncateWithNotice(
        `<recent_session_history>\n${JSON.stringify(excerpt.turns, null, 2)}\n`
          + "</recent_session_history>",
        CLAUDE_ROLLOVER_HISTORY_BLOCK_MAX_CHARS,
        "recent session history",
      )
    : "";
  const noteOnly = appendAttachmentPathNotes("", attachmentNotePaths);
  const noteReserve = noteOnly.length > 0
    ? noteOnly.length + (replayPrompt.length > 0 ? 2 : 0)
    : 0;
  const boundedReplayBody = truncateWithNotice(
    replayPrompt,
    Math.max(0, CLAUDE_ROLLOVER_REPLAY_INPUT_MAX_CHARS - noteReserve),
    "replayed input",
  );
  const boundedReplay = appendAttachmentPathNotes(boundedReplayBody, attachmentNotePaths);
  const assignedBlock = formatContextItems(context.contextItems.filter((item) => item.key === "assigned_cards"));
  const remainingContext = truncateWithNotice(
    formatContextItems(context.contextItems.filter((item) => item.key !== "assigned_cards")),
    CLAUDE_ROLLOVER_CONTEXT_MAX_CHARS - assignedBlock.length - (assignedBlock ? 2 : 0),
    "dynamic context",
  );
  const contextBlock = [remainingContext, assignedBlock].filter(Boolean).join("\n\n");
  const sections = [
    notice,
    history,
    `<replayed_input>\n${boundedReplay}\n</replayed_input>`,
    contextBlock,
  ].filter((value) => value.length > 0);
  return truncateClaudeTextToEstimatedTokens(
    truncateWithNotice(sections.join("\n\n"), limits.maxChars, "rollover prompt"),
    limits.maxEstimatedTokens,
    "rollover prompt",
  );
}

export function truncateWithNotice(value: string, limit: number, label: string): string {
  if (value.length <= limit) return value;
  const suffix = `\n[${label} truncated by ${value.length - limit} characters]`;
  if (suffix.length >= limit) return value.slice(0, limit);
  return `${value.slice(0, limit - suffix.length)}${suffix}`;
}

function createAttachmentSource(
  sessionId: string,
  text: string,
  attachmentIds?: string[],
  attachmentPaths?: string[],
  attachmentBindings?: AttachmentTurnSource["attachmentBindings"],
  deliveryId?: string,
): AttachmentTurnSource | undefined {
  if ((attachmentIds?.length ?? 0) === 0) return undefined;
  return {
    sessionId,
    text: stripManagedAttachmentPathNotes(text, attachmentBindings ?? []),
    attachmentIds: [...attachmentIds!],
    ...(attachmentPaths === undefined ? {} : { attachmentPaths: [...attachmentPaths] }),
    ...(attachmentBindings === undefined
      ? {}
      : { attachmentBindings: attachmentBindings.map((binding) => ({ ...binding })) }),
    ...(deliveryId === undefined ? {} : { deliveryId }),
  };
}

export function prepareGenerationTurnInput(
  task: Task,
  agent: AgentProfile,
  context: GenerationPreparedContext,
  interventions: InterventionMessage[],
  originalInterventions: InterventionMessage[] = interventions,
): TaskTurnInput {
  const firstIntervention = interventions[0];
  if (!firstIntervention) {
    throw new Error("generation rollover requires a queued intervention");
  }
  const active = task.activeGenerationRollover;
  if (!active) throw new Error("generation rollover input requires an active generation");

  const currentCallerInfo = interventions.at(-1)?.callerInfo ?? task.callerInfo;
  const inputUuid = firstIntervention.deliveryId
    ? buildDeliveryInputUuid(firstIntervention.deliveryId)
    : undefined;
  const composed = composeInterventionTurnPrompt(interventions.map((message) => ({
    ...message,
    context: message.context?.filter((item) => item.key !== "assigned_cards"),
  })));
  const isClaude = effectiveTaskBackend(task, agent) === "claude";
  const composedPrompt = composeFirstTurnPromptWithMaterial({
    ...context,
    effectiveSystemPrompt: isClaude ? undefined : context.effectiveSystemPrompt,
    assembledPrompt: composed.prompt,
  }, composed.inputMaterialParts);
  const systemPrompt = isClaude ? context.effectiveSystemPrompt : undefined;
  const systemParts = systemPrompt
    ? resolveSystemInputMaterialParts(context.inputMaterialBreakdown?.systemParts, systemPrompt)
    : [];

  task.needsFullContextReinjection = false;
  if (task.codexThreadId) task.lastInjectedClaudeSessionId = task.codexThreadId;
  if (currentCallerInfo) task.lastInjectedCallerInfo = currentCallerInfo;

  const runnerInterventionIds = interventions
    .map((message) => message.runnerInterventionId)
    .filter((id): id is string => id !== undefined);
  return {
    prompt: composedPrompt.prompt,
    inputMaterialParts: [...systemParts, ...composedPrompt.parts],
    imageAttachmentPaths: composed.imageAttachmentPaths,
    ...(systemPrompt !== undefined
      ? { systemPrompt }
      : {}),
    ...(inputUuid ? { inputUuid } : {}),
    ...(firstIntervention.runnerInterventionId
      ? { runnerInterventionId: firstIntervention.runnerInterventionId }
      : {}),
    ...(runnerInterventionIds.length > 0 ? { runnerInterventionIds } : {}),
    turnOrigin: interventionTurnOrigin(firstIntervention, inputUuid),
    interventions: originalInterventions,
    backendSessionRolloverFrom: active.fromBackendSessionId,
    generationRollover: true,
    generationCheckpointStats: context.checkpointStats,
  };
}

function resolveSystemInputMaterialParts(
  parts: readonly InputMaterialPartV1[] | undefined,
  text: string,
): readonly InputMaterialPartV1[] {
  return inputMaterialPartsMatchText(parts, text)
    ? parts
    : [createInputMaterialPart(
        "system_prompt",
        "fallback:system_source_breakdown",
        text,
      )];
}
