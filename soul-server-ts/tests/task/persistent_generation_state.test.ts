import { describe, expect, it } from "vitest";

import {
  buildPersistentGenerationMetadataEntry,
  extractPersistentGeneration,
} from "../../src/task/task_metadata.js";
import { resolveGenerationState } from "../../src/task/persistent_generation_state.js";

const firstCall = {
  generation: 1,
  inputTokens: 246708,
  cachedInputTokens: 245563,
  modelPreset: "claude-opus",
  model: "claude-opus-4-6",
  measuredAt: "2026-10-05T09:00:00.000Z",
};

const applyingState = {
  number: 1,
  backendSessionId: "native-old",
  startedAt: "2026-10-01T09:00:00.000Z",
  firstCall,
  pending: {
    number: 2,
    reason: "manual",
    requestedAt: "2026-10-05T09:00:00.000Z",
    targetModelPreset: "codex-balanced",
    targetReasoningEffort: "high",
    applyingFrom: "native-old",
    previousModelPreset: "codex-source",
    previousBackend: "codex",
  },
};

describe("extractPersistentGeneration", () => {
  it("restores the metadata entry and first-call usage", () => {
    expect(extractPersistentGeneration([{
      type: "persistent_generation",
      value: {
        number: 2,
        backend_session_id: "native-old",
        started_at: "2026-10-01T09:00:00.000Z",
        first_call: {
          generation: 1,
          input_tokens: 246708,
          cached_input_tokens: 245563,
          model_preset: "claude-opus",
          model: "claude-opus-4-6",
          measured_at: "2026-10-05T09:00:00.000Z",
        },
        pending: null,
      },
    }])).toEqual({
      number: 2,
      backendSessionId: "native-old",
      startedAt: "2026-10-01T09:00:00.000Z",
      firstCall,
    });
  });

  it("drops first-call usage when either token count is invalid", () => {
    expect(extractPersistentGeneration([{
      type: "persistent_generation",
      value: {
        number: 2,
        first_call: {
          generation: 1,
          input_tokens: -1,
          cached_input_tokens: 0,
          model_preset: "claude-opus",
          model: "claude-opus-4-6",
          measured_at: "2026-10-05T09:00:00.000Z",
        },
      },
    }])?.firstCall).toBeUndefined();
  });

  it("round-trips the previous model selection stored with an applying request", () => {
    const entry = buildPersistentGenerationMetadataEntry(applyingState);

    expect(entry).toMatchObject({
      type: "persistent_generation",
      value: {
        pending: {
          applying_from: "native-old",
          previous_model_preset: "codex-source",
          previous_backend: "codex",
        },
      },
    });
    expect(extractPersistentGeneration([entry])).toEqual(applyingState);
  });
});

describe("resolveGenerationState", () => {
  it("defaults a missing entry to generation one", () => {
    expect(resolveGenerationState(undefined, "native-current").persistentGeneration)
      .toEqual({ number: 1 });
  });

  it("leaves a request pending before applying starts", () => {
    const state = {
      number: 1,
      firstCall,
      pending: { ...applyingState.pending, applyingFrom: undefined },
    };

    expect(resolveGenerationState(state, "native-old")).toEqual({
      persistentGeneration: state,
      activeGenerationRollover: undefined,
    });
  });

  it("restores the active rollover while the native session ID is still the predecessor", () => {
    expect(resolveGenerationState(applyingState, "native-old")).toEqual({
      persistentGeneration: applyingState,
      activeGenerationRollover: {
        number: 2,
        reason: "manual",
        requestedAt: "2026-10-05T09:00:00.000Z",
        fromBackendSessionId: "native-old",
        previousModelPreset: "codex-source",
        previousBackend: "codex",
      },
    });
  });

  it("treats a changed native session ID as completed and preserves the prior first call", () => {
    expect(resolveGenerationState(applyingState, "native-new")).toEqual({
      persistentGeneration: {
        number: 2,
        backendSessionId: "native-new",
        firstCall,
      },
      activeGenerationRollover: undefined,
    });
  });
});
