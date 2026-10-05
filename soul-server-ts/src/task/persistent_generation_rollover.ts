import type { AgentProfile } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { PersistentCheckpointStats } from "../context/persistent_checkpoint.js";
import type { SessionMutationHost } from "../control_plane/persistence_host_clients.js";
import { UnknownModelPresetError } from "../model_catalog.js";
import { resolveReasoningEffortForCreate } from "./task_reasoning_effort.js";
import { effectiveTaskBackend } from "./task_model_preset.js";
import { isRuntimeFollowup, sortInterventionsByPriority } from "./task_intervention_queue.js";
import { buildPersistentGenerationMetadataEntry } from "./task_metadata.js";

import type { ActiveGenerationRollover, Task } from "./task_models.js";

export function beginGenerationRolloverIfPending(
  task: Task,
  agent: AgentProfile,
  modelCatalog?: Pick<ModelCatalog, "resolve">,
): ActiveGenerationRollover | undefined {
  const pending = task.persistentGeneration?.pending;
  if (!pending) return undefined;

  if (pending.applyingFrom === undefined) {
    const firstIntervention = sortInterventionsByPriority(task.interventionQueue)[0];
    if (
      task.persistent !== true
      || task.runnerRetainedForDetachedWork === true
      || task.interventionQueue.length === 0
      || (firstIntervention !== undefined && isRuntimeFollowup(firstIntervention))
      || !task.codexThreadId
    ) {
      return undefined;
    }
  }

  let active = task.activeGenerationRollover;
  if (!active) {
    const fromBackendSessionId = pending.applyingFrom ?? task.codexThreadId;
    if (!fromBackendSessionId) return undefined;
    active = {
      number: pending.number,
      reason: pending.reason,
      fromBackendSessionId,
      previousModelPreset: task.modelPreset ?? null,
      previousBackend: effectiveTaskBackend(task, agent),
    };
    task.activeGenerationRollover = active;
  } else {
    active.previousModelPreset ??= task.modelPreset ?? null;
    active.previousBackend ??= effectiveTaskBackend(task, agent);
  }

  if (!modelCatalog) {
    throw new Error("Model catalog is not configured for persistent generation rollover");
  }

  let targetPreset;
  try {
    targetPreset = modelCatalog.resolve(pending.targetModelPreset);
  } catch (error) {
    if (!(error instanceof UnknownModelPresetError)) throw error;
    // A requested preset can disappear after P7 accepted it. Keep this execution
    // on its current model; a later explicit request can choose an available one.
    task.persistentGeneration = { ...task.persistentGeneration!, pending: undefined };
    task.metadata = replacePersistentGenerationMetadata(
      task,
      buildPersistentGenerationMetadataEntry(task.persistentGeneration),
    );
    return undefined;
  }

  const reasoningEffort = resolveReasoningEffortForCreate(
    targetPreset,
    pending.targetReasoningEffort,
  );
  task.modelPreset = targetPreset.id;
  task.model = targetPreset.model;
  task.modelPresetBackend = targetPreset.backend;
  task.modelPresetEnv = targetPreset.env;
  task.reasoningEffort = reasoningEffort;
  task.claudeContextUsage = undefined;
  return active;
}

export async function commitStart(
  task: Task,
  persistence: EventPersistence,
  sessionMutations: Pick<SessionMutationHost, "setModelSelection">,
): Promise<void> {
  const active = task.activeGenerationRollover;
  const current = task.persistentGeneration;
  const pending = current?.pending;
  if (!active || !current || !pending) return;

  const applyingState = {
    ...current,
    pending: { ...pending, applyingFrom: active.fromBackendSessionId },
  };
  const applyingEntry = buildPersistentGenerationMetadataEntry(applyingState);
  const metadataEventId = await persistence.enqueueMetadataEffect(
    task.agentSessionId,
    applyingEntry,
    {
      replaceExistingType: "persistent_generation",
      waitForAck: true,
      semanticDedupeKey: `generation_applying:${task.agentSessionId}:${active.number}`,
      ...(task.executionRegistration
        ? { registrationId: task.executionRegistration.registrationId }
        : {}),
    },
  );
  task.metadata = replacePersistentGenerationMetadata(task, applyingEntry);
  task.persistentGeneration = applyingState;
  if (metadataEventId !== null) task.lastEventId = metadataEventId;

  const selectionChanged =
    active.previousModelPreset !== task.modelPreset
    || pending.targetModelPreset !== task.modelPreset
    || pending.targetReasoningEffort !== task.reasoningEffort;
  if (selectionChanged) {
    await sessionMutations.setModelSelection(
      task.agentSessionId,
      {
        modelPreset: task.modelPreset ?? null,
        model: task.model ?? null,
        reasoningEffort: task.reasoningEffort ?? null,
      },
      `persistent_generation_model_selection:${task.agentSessionId}:${active.number}`,
    );
  }
}

export async function publishStarted(
  task: Task,
  checkpoint: PersistentCheckpointStats,
  persistence: EventPersistence,
): Promise<void> {
  const active = task.activeGenerationRollover;
  if (!active) return;
  const previousBackend = active.previousBackend;
  const currentBackend = task.modelPresetBackend;
  if (!previousBackend || !currentBackend) {
    throw new Error("Persistent generation model backends are not resolved");
  }
  const event = {
    type: "generation_started",
    generation: active.number,
    reason: active.reason,
    previous: {
      model_preset: active.previousModelPreset ?? null,
      backend: previousBackend,
    },
    current: {
      model_preset: task.modelPreset ?? null,
      backend: currentBackend,
      model: task.model ?? null,
    },
    checkpoint: {
      estimated_tokens: checkpoint.estimatedTokens,
      chars: checkpoint.chars,
      sections: checkpoint.sections,
      summarized_through_turn: checkpoint.summarizedThroughTurn,
      recent_from_event_id: checkpoint.recentFromEventId,
      recent_to_event_id: checkpoint.recentToEventId,
    },
    timestamp: Date.now(),
    _dedupe_key: `generation_started:${task.agentSessionId}:${active.number}`,
  } as unknown as import("../engine/protocol.js").SSEEventPayload;
  const { eventId } = await persistence.enqueueEventAndWaitForSessionAck(
    task.agentSessionId,
    event,
    undefined,
    task.executionRegistration?.registrationId,
  );
  task.lastEventId = eventId;
}

export async function complete(
  task: Task,
  persistence: EventPersistence,
): Promise<boolean> {
  const active = task.activeGenerationRollover;
  const nativeSessionId = task.codexThreadId;
  if (!active || !nativeSessionId || nativeSessionId === active.fromBackendSessionId) {
    return false;
  }

  const previousFirstCall = task.persistentGeneration?.firstCall;
  const firstCall = active.firstCall
    ? {
        generation: active.number,
        inputTokens: active.firstCall.inputTokens,
        cachedInputTokens: active.firstCall.cachedInputTokens,
        modelPreset: task.modelPreset ?? "",
        model: task.model ?? "",
        measuredAt: new Date().toISOString(),
      }
    : previousFirstCall;
  const nextState = {
    number: active.number,
    backendSessionId: nativeSessionId,
    startedAt: new Date().toISOString(),
    ...(firstCall ? { firstCall } : {}),
  };
  const entry = buildPersistentGenerationMetadataEntry(nextState);
  const eventId = await persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
    replaceExistingType: "persistent_generation",
    waitForAck: true,
    semanticDedupeKey: `generation_complete:${task.agentSessionId}:${active.number}`,
    ...(task.executionRegistration
      ? { registrationId: task.executionRegistration.registrationId }
      : {}),
  });
  task.metadata = replacePersistentGenerationMetadata(task, entry);
  task.persistentGeneration = nextState;
  task.activeGenerationRollover = undefined;
  if (eventId !== null) task.lastEventId = eventId;
  return true;
}

function replacePersistentGenerationMetadata(
  task: Task,
  entry: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [
    ...(task.metadata ?? []).filter((item) => item.type !== "persistent_generation"),
    entry,
  ];
}
