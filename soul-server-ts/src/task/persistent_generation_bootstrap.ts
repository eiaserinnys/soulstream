import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import { buildPersistentGenerationMetadataEntry } from "./task_metadata.js";
import type { PersistentGenerationBootstrap, PersistentGenerationState, Task } from "./task_models.js";

export interface GenerationExecutionIdentity {
  generation: number;
  nativeId: string | undefined;
  modelPreset: string;
  model: string;
}

export interface BootstrapUpdate {
  bootstrap: PersistentGenerationBootstrap;
  firstCall?: PersistentGenerationState["firstCall"];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function captureGenerationBootstrap(
  task: Task,
  event: SSEEventPayload,
  identity: GenerationExecutionIdentity,
  contextTokens: number | undefined,
  eventId: number | null,
): BootstrapUpdate | undefined {
  const b = task.persistentGeneration?.bootstrap;
  if (!b || b.status !== "collecting" || b.generation !== identity.generation
    || b.modelPreset !== identity.modelPreset || b.model !== identity.model
    || (b.backendSessionId !== null && b.backendSessionId !== identity.nativeId)) return undefined;
  const payload = event as Record<string, unknown>;
  if (payload.type !== "complete" && payload.type !== "error") return undefined;
  const usage = record(payload.usage);
  const first = record(payload.first_call);
  const growth = record(payload.generation_usage);
  const input = number(usage?.input_tokens);
  const cached = number(usage?.cached_input_tokens);
  const output = number(usage?.output_tokens);
  const reasoning = number(usage?.reasoning_output_tokens);
  const firstInput = number(first?.input_tokens);
  const firstCached = number(first?.cached_input_tokens);
  const context = number(contextTokens);
  const timestamp = new Date().toISOString();
  const valid = payload.type === "complete" && identity.nativeId !== undefined && input !== null && input > 0 && cached !== null && cached <= input
    && output !== null && reasoning !== null && firstInput !== null && firstInput > 0
    && firstCached !== null && firstCached <= firstInput && context !== null && context > 0;
  const firstCall = firstInput !== null && firstCached !== null
    ? { inputTokens: firstInput, cachedInputTokens: firstCached } : null;
  return {
    bootstrap: {
      ...b, backendSessionId: identity.nativeId ?? null, status: valid ? "complete" : "unavailable",
      firstCall, firstTurnContextTokens: context, initInputTokens: input, initCachedTokens: cached,
      initOutputTokens: output, initReasoningTokens: reasoning, modelCallCount: number(growth?.model_call_count),
      growthTokens: number(growth?.context_growth_tokens), growthSamples: number(growth?.context_growth_samples),
      completedAt: timestamp, sourceCompleteEventId: eventId,
    },
    ...(valid && firstCall ? { firstCall: {
      generation: b.generation, ...firstCall, modelPreset: b.modelPreset, model: b.model,
      measuredAt: timestamp, contextReset: b.contextReset,
    } } : {}),
  };
}

export async function persistGenerationBootstrap(
  task: Task, update: BootstrapUpdate, persistence: EventPersistence,
): Promise<void> {
  const state = task.persistentGeneration;
  if (!state || state.bootstrap?.status !== "collecting"
    || state.bootstrap.generation !== update.bootstrap.generation) return;
  const next = { ...state, bootstrap: update.bootstrap,
    ...(update.firstCall ? { firstCall: update.firstCall } : {}) };
  const entry = buildPersistentGenerationMetadataEntry(next);
  const id = await persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
    replaceExistingType: "persistent_generation", waitForAck: true,
    semanticDedupeKey: `generation_bootstrap:${task.agentSessionId}:${update.bootstrap.generation}:${update.bootstrap.backendSessionId}`,
    ...(task.executionRegistration ? { registrationId: task.executionRegistration.registrationId } : {}),
  });
  task.persistentGeneration = next;
  task.metadata = [...(task.metadata ?? []).filter(e => e.type !== "persistent_generation"), entry];
  if (id !== null) task.lastEventId = id;
}

/** Accumulate successful per-turn growth without scanning the event history. */
export async function persistGenerationGrowth(
  task: Task, event: SSEEventPayload, identity: GenerationExecutionIdentity,
  eventId: number | null, persistence: EventPersistence,
): Promise<void> {
  if (event.type !== "complete" || eventId === null || !identity.nativeId) return;
  const growth = record((event as Record<string, unknown>).generation_usage);
  const tokens = number(growth?.context_growth_tokens);
  const samples = number(growth?.context_growth_samples);
  if (tokens === null || samples === null || samples === 0) return;
  const existing = (task.metadata ?? []).find(e => e.type === "persistent_generation_growth");
  const oldValue = record(existing?.value);
  const presets = { ...record(oldValue?.presets) };
  const old = record(presets[identity.modelPreset]);
  if (old && number(old.last_event_id) === eventId) return;
  const sameModel = old?.model === identity.model;
  presets[identity.modelPreset] = {
    model: identity.model, tokens: (sameModel ? number(old?.tokens) ?? 0 : 0) + tokens,
    samples: (sameModel ? number(old?.samples) ?? 0 : 0) + samples, last_event_id: eventId,
  };
  const entry = { type: "persistent_generation_growth", value: { presets } };
  const id = await persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
    replaceExistingType: "persistent_generation_growth", waitForAck: true,
    semanticDedupeKey: `generation_growth:${task.agentSessionId}:${eventId}`,
    ...(task.executionRegistration ? { registrationId: task.executionRegistration.registrationId } : {}),
  });
  task.metadata = [...(task.metadata ?? []).filter(e => e.type !== entry.type), entry];
  if (id !== null) task.lastEventId = id;
}
