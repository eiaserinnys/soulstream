import type { AgentProfile } from "../agent_registry.js";
import type { GenerationPreparedContext } from "../context/context_builder.js";
import { composeFirstTurnPrompt } from "../context/context_builder.js";

import { buildDeliveryInputUuid } from "./delivery_identity.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { effectiveTaskBackend } from "./task_model_preset.js";
import type { TaskTurnInput } from "./task_turn_input_builder.js";
import { interventionTurnOrigin } from "./turn_origin.js";

export function prepareGenerationTurnInput(
  task: Task,
  agent: AgentProfile,
  context: GenerationPreparedContext,
  interventions: InterventionMessage[],
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
  const prompt = composeFirstTurnPrompt({
    ...context,
    effectiveSystemPrompt: isClaude ? undefined : context.effectiveSystemPrompt,
    assembledPrompt: composed.prompt,
  });

  task.needsFullContextReinjection = false;
  if (task.codexThreadId) task.lastInjectedClaudeSessionId = task.codexThreadId;
  if (currentCallerInfo) task.lastInjectedCallerInfo = currentCallerInfo;

  const runnerInterventionIds = interventions
    .map((message) => message.runnerInterventionId)
    .filter((id): id is string => id !== undefined);
  return {
    prompt,
    imageAttachmentPaths: composed.imageAttachmentPaths,
    ...(isClaude && context.effectiveSystemPrompt !== undefined
      ? { systemPrompt: context.effectiveSystemPrompt }
      : {}),
    ...(inputUuid ? { inputUuid } : {}),
    ...(firstIntervention.runnerInterventionId
      ? { runnerInterventionId: firstIntervention.runnerInterventionId }
      : {}),
    ...(runnerInterventionIds.length > 0 ? { runnerInterventionIds } : {}),
    turnOrigin: interventionTurnOrigin(firstIntervention, inputUuid),
    interventions,
    backendSessionRolloverFrom: active.fromBackendSessionId,
    generationRollover: true,
    generationCheckpointStats: context.checkpointStats,
  };
}
