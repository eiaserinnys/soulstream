import type {
  ActiveGenerationRollover,
  PersistentGenerationState,
  Task,
} from "./task_models.js";

export interface ResolvedGenerationState {
  persistentGeneration: PersistentGenerationState;
  activeGenerationRollover?: ActiveGenerationRollover;
}

export function resolveGenerationState(
  state: PersistentGenerationState | undefined,
  currentNativeSessionId: string | null | undefined,
  currentModel: Pick<Task, "modelPreset" | "reasoningEffort">,
): ResolvedGenerationState {
  const current = state ?? { number: 1 };
  const pending = current.pending;
  if (!pending?.applyingFrom) {
    return {
      persistentGeneration: current,
      activeGenerationRollover: undefined,
    };
  }

  if (currentNativeSessionId !== pending.applyingFrom) {
    const targetChanged = pending.targetModelPreset !== currentModel.modelPreset
      || pending.targetReasoningEffort !== currentModel.reasoningEffort;
    const { applyingFrom: _from, previousModelPreset: _preset, previousBackend: _backend,
      ...requested } = pending;
    return {
      persistentGeneration: {
        number: pending.number,
        ...(currentNativeSessionId ? { backendSessionId: currentNativeSessionId } : {}),
        ...(current.firstCall === undefined ? {} : { firstCall: current.firstCall }),
        ...(targetChanged ? { pending: { ...requested, number: pending.number + 1 } } : {}),
      },
      activeGenerationRollover: undefined,
    };
  }

  return {
    persistentGeneration: current,
    activeGenerationRollover: {
      number: pending.number,
      reason: pending.reason,
      requestedAt: pending.requestedAt,
      fromBackendSessionId: pending.applyingFrom,
      resetContext: pending.resetContext === true,
      keepInstructions: pending.keepInstructions !== false,
      ...(pending.previousModelPreset === undefined
        ? {}
        : { previousModelPreset: pending.previousModelPreset }),
      ...(pending.previousBackend === undefined
        ? {}
        : { previousBackend: pending.previousBackend }),
    },
  };
}
