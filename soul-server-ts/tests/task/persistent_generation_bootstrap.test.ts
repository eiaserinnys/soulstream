import { describe, expect, it, vi } from "vitest";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import type { Task } from "../../src/task/task_models.js";
import { captureGenerationBootstrap, persistGenerationBootstrap } from "../../src/task/persistent_generation_bootstrap.js";

const identity = { generation: 297, nativeId: "native-297", modelPreset: "gemini-4-hydrogen", model: "gemini-4-hydrogen" };
function fixture(): Task {
  return {
    agentSessionId: "session", lastEventId: 1,
    persistentGeneration: {
      number: 297, backendSessionId: "native-297", bootstrap: {
        ...identity, backendSessionId: identity.nativeId, contextReset: false, status: "collecting",
        firstCall: null, firstTurnContextTokens: null, initInputTokens: null, initCachedTokens: null,
        initOutputTokens: null, initReasoningTokens: null, modelCallCount: null, growthTokens: null,
        growthSamples: null, startedAt: "2026-11-14T00:00:00Z", completedAt: null,
        sourceCompleteEventId: null, priceVersion: "test",
      },
    },
  } as unknown as Task;
}

describe("generation bootstrap terminal capture", () => {
  it.each([
    { type: "complete" },
    { type: "error", fatal: true, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 1 } },
  ])("closes an unmeasured or failed first terminal and cannot recapture a later turn", async terminal => {
    const task = fixture();
    const update = captureGenerationBootstrap(task, terminal as SSEEventPayload, identity, 120, 14)!;
    expect(update.bootstrap.status).toBe("unavailable");
    const write = vi.fn(async () => 15);
    await persistGenerationBootstrap(task, update, { enqueueMetadataEffect: write } as unknown as EventPersistence);
    expect(write).toHaveBeenCalledWith("session", expect.anything(), expect.objectContaining({
      semanticDedupeKey: "generation_bootstrap:session:297:native-297",
    }));
    expect(captureGenerationBootstrap(task, terminal as SSEEventPayload, identity, 200, 16)).toBeUndefined();
  });
  it("does not assign another generation or native session to this bootstrap", () => {
    const task = fixture();
    const event = { type: "complete" } as SSEEventPayload;
    expect(captureGenerationBootstrap(task, event, { ...identity, generation: 298 }, 200, 1)).toBeUndefined();
    expect(captureGenerationBootstrap(task, event, { ...identity, nativeId: "other" }, 200, 1)).toBeUndefined();
  });
});
