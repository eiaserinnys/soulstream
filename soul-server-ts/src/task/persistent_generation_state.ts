import type {
  ActiveGenerationRollover,
  PersistentGenerationState,
} from "./task_models.js";

export interface ResolvedGenerationState {
  persistentGeneration: PersistentGenerationState;
  activeGenerationRollover?: ActiveGenerationRollover;
}

export function resolveGenerationState(
  state: PersistentGenerationState | undefined,
  currentNativeSessionId: string | null | undefined,
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
    return {
      persistentGeneration: {
        number: pending.number,
        ...(currentNativeSessionId ? { backendSessionId: currentNativeSessionId } : {}),
        ...(current.firstCall === undefined ? {} : { firstCall: current.firstCall }),
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
      ...(pending.previousModelPreset === undefined
        ? {}
        : { previousModelPreset: pending.previousModelPreset }),
      ...(pending.previousBackend === undefined
        ? {}
        : { previousBackend: pending.previousBackend }),
    },
  };
}
