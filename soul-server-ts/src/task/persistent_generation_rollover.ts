import type { Logger } from "pino";
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
import { resolveGenerationState } from "./persistent_generation_state.js";

import type {
  ActiveGenerationRollover,
  PersistentGenerationRolloverFailure,
  Task,
} from "./task_models.js";

export async function reconcileGenerationBeforeExecution(
  task: Task,
  persistence: EventPersistence,
): Promise<void> {
  const current = task.persistentGeneration;
  if (!current?.pending?.applyingFrom) return;
  const resolved = resolveGenerationState(current, task.codexThreadId, task);
  if (resolved.persistentGeneration === current) return;
  const entry = buildPersistentGenerationMetadataEntry(resolved.persistentGeneration);
  const eventId = await persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
    replaceExistingType: "persistent_generation",
    waitForAck: true,
    semanticDedupeKey:
      `generation_reconciled:${task.agentSessionId}:${current.pending.number}:${current.pending.requestedAt}`,
    ...(task.executionRegistration
      ? { registrationId: task.executionRegistration.registrationId }
      : {}),
  });
  task.metadata = replacePersistentGenerationMetadata(task, entry);
  task.persistentGeneration = resolved.persistentGeneration;
  task.activeGenerationRollover = resolved.activeGenerationRollover;
  if (eventId !== null) task.lastEventId = eventId;
}

export function beginGenerationRolloverIfPending(
  task: Task,
  agent: AgentProfile,
  modelCatalog?: Pick<ModelCatalog, "resolve">,
  logger?: Pick<Logger, "warn">,
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
    const isResumedApplication = pending.applyingFrom !== undefined;
    active = {
      number: pending.number,
      reason: pending.reason,
      requestedAt: pending.requestedAt,
      fromBackendSessionId,
      resetContext: pending.resetContext === true,
      keepInstructions: pending.keepInstructions !== false,
      ...(isResumedApplication
        ? {
            ...(pending.previousModelPreset === undefined
              ? {}
              : { previousModelPreset: pending.previousModelPreset }),
            ...(pending.previousBackend === undefined
              ? {}
              : { previousBackend: pending.previousBackend }),
          }
        : {
            previousModelPreset: task.modelPreset ?? null,
            previousBackend: effectiveTaskBackend(task, agent),
          }),
    };
    task.activeGenerationRollover = active;
  } else {
    active.requestedAt = pending.requestedAt;
    active.resetContext = pending.resetContext === true;
    active.keepInstructions = pending.keepInstructions !== false;
    if (pending.applyingFrom === undefined) {
      active.previousModelPreset ??= task.modelPreset ?? null;
      active.previousBackend ??= effectiveTaskBackend(task, agent);
    } else {
      active.previousModelPreset = pending.previousModelPreset;
      active.previousBackend = pending.previousBackend;
    }
  }

  if (!modelCatalog) {
    throw new Error("Model catalog is not configured for persistent generation rollover");
  }

  let targetPreset;
  try {
    targetPreset = modelCatalog.resolve(pending.targetModelPreset);
  } catch (error) {
    if (!(error instanceof UnknownModelPresetError)) throw error;
    if (pending.applyingFrom !== undefined) {
      throw new Error(
        `Persistent generation target preset "${pending.targetModelPreset}" is unavailable while applying. Request another preset or restore it in the model catalog.`,
        { cause: error },
      );
    }
    // A requested preset can disappear after P7 accepted it. Keep this execution
    // on its current model and preserve the failure alongside the cleared request.
    const failure: PersistentGenerationRolloverFailure = {
      number: pending.number,
      requestedAt: pending.requestedAt,
      targetModelPreset: pending.targetModelPreset,
      reason: "target_model_preset_unavailable",
      failedAt: new Date().toISOString(),
    };
    logger?.warn(
      {
        sessionId: task.agentSessionId,
        generation: failure.number,
        targetModelPreset: failure.targetModelPreset,
      },
      "Persistent generation target preset is unavailable; continuing with the current generation",
    );
    const nextState = { ...task.persistentGeneration!, pending: undefined };
    const entry = buildPersistentGenerationMetadataEntry(nextState);
    const value = entry.value as Record<string, unknown>;
    entry.value = {
      ...value,
      last_failure: {
        generation: failure.number,
        requested_at: failure.requestedAt,
        target_model_preset: failure.targetModelPreset,
        reason: failure.reason,
        failed_at: failure.failedAt,
      },
    };
    task.persistentGeneration = nextState;
    task.metadata = replacePersistentGenerationMetadata(task, entry);
    task.activeGenerationRollover = undefined;
    task.pendingPersistentGenerationRolloverFailure = failure;
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

export async function persistUnavailablePresetFailure(
  task: Task,
  persistence: EventPersistence,
): Promise<void> {
  const failure = task.pendingPersistentGenerationRolloverFailure;
  if (!failure) return;
  let entry: Record<string, unknown> | undefined;
  for (let index = (task.metadata?.length ?? 0) - 1; index >= 0; index -= 1) {
    const candidate = task.metadata?.[index];
    if (candidate?.type === "persistent_generation") {
      entry = candidate;
      break;
    }
  }
  if (!entry) throw new Error("Persistent generation failure metadata is missing");
  const eventId = await persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
    replaceExistingType: "persistent_generation",
    waitForAck: true,
    semanticDedupeKey:
      `generation_failure:${task.agentSessionId}:${failure.number}:${failure.requestedAt}`,
    ...(task.executionRegistration
      ? { registrationId: task.executionRegistration.registrationId }
      : {}),
  });
  if (eventId !== null) task.lastEventId = eventId;
  task.pendingPersistentGenerationRolloverFailure = undefined;
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

  if (active.previousBackend === undefined) {
    throw new Error("Persistent generation rollover is missing its stored previous backend");
  }

  const applyingState = {
    ...current,
    pending: {
      ...pending,
      requestedAt: active.requestedAt,
      applyingFrom: active.fromBackendSessionId,
      previousModelPreset: active.previousModelPreset ?? null,
      previousBackend: active.previousBackend,
    },
  };
  const applyingEntry = buildPersistentGenerationMetadataEntry(applyingState);
  const metadataEventId = await persistence.enqueueMetadataEffect(
    task.agentSessionId,
    applyingEntry,
    {
      replaceExistingType: "persistent_generation",
      waitForAck: true,
      semanticDedupeKey:
        `generation_applying:${task.agentSessionId}:${active.number}:${active.requestedAt}`,
      ...(task.executionRegistration
        ? { registrationId: task.executionRegistration.registrationId }
        : {}),
    },
  );
  task.metadata = replacePersistentGenerationMetadata(task, applyingEntry);
  task.persistentGeneration = applyingState;
  if (metadataEventId !== null) task.lastEventId = metadataEventId;

  await sessionMutations.setModelSelection(
    task.agentSessionId,
    {
      modelPreset: task.modelPreset ?? null,
      model: task.model ?? null,
      reasoningEffort: task.reasoningEffort ?? null,
    },
    `persistent_generation_model_selection:${task.agentSessionId}:${active.number}:${active.requestedAt}`,
  );
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
    context_reset: active.resetContext === true,
    _dedupe_key:
      `generation_started:${task.agentSessionId}:${active.number}:${active.requestedAt}`,
    timestamp: Date.now() / 1000,
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
        contextReset: active.resetContext === true,
      }
    : previousFirstCall;
  const pending = task.persistentGeneration?.pending;
  const resolved = pending ? resolveGenerationState({
    ...task.persistentGeneration!,
    pending: { ...pending, applyingFrom: active.fromBackendSessionId },
  }, nativeSessionId, task).persistentGeneration : { number: active.number };
  const nextState = {
    ...resolved,
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
