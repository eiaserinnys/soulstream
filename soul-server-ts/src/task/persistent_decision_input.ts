import type { Logger } from "pino";

import { readStoredPersistentSettings } from "@soulstream/wire-schema/persistent-session-settings";

import {
  readProviderUsageObservation,
  type DecisionProvider,
} from "../auth/provider_usage_observation.js";
import type {
  ProviderLimits,
  ProviderUsageCommandHandler,
} from "../auth/provider_usage.js";
import { DEFAULT_CONFIG, GENERATION_COST_SEEDS, firstCallCacheEstimate } from "./persistent_decision_config.js";
import { findModelRow } from "@soulstream/model-catalog";
import { extractPersistentGeneration } from "./task_metadata.js";
import type { GenerationCostProfile } from "./persistent_generation_cost.js";
import type {
  AccountObservation,
  DecisionInput,
  DecisionTrigger,
} from "./persistent_decision.js";
import { UnknownModelPresetError, type ModelCatalog } from "../model_catalog.js";
import type { SessionDB } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "./task_models.js";
import { isCacheKeepaliveInput } from "./persistent_keepalive_marker.js";

const DECISION_EVENT_WINDOW = 200;
/** 판정은 프리셋별 최신 first_call 하나만 쓰므로 최신 세대 기록 이만큼이면 충분하다. */
const GENERATION_METADATA_READ_LIMIT = 50;
const HUMAN_SOURCES = new Set(["browser", "soul-app", "slack"]);
const INPUT_EVENT_TYPES = new Set(["user_message", "intervention_sent"]);

export interface PersistentDecisionInputDependencies {
  db: Pick<SessionDB, "readEvents">;
  modelCatalog: Pick<ModelCatalog, "resolve" | "snapshot">;
  providerUsage: ProviderUsageCommandHandler;
  logger: Pick<Logger, "warn">;
}

export interface BuildPersistentDecisionInputOptions {
  task: Task;
  trigger: DecisionTrigger;
  now: Date;
  lastCallEndedAt?: string;
  limitResetAt?: string;
}

export async function buildPersistentDecisionInput(
  options: BuildPersistentDecisionInputOptions,
  deps: PersistentDecisionInputDependencies,
): Promise<DecisionInput> {
  const { task, trigger, now } = options;
  const events = await deps.db.readEvents(
    task.agentSessionId,
    Math.max(0, task.lastEventId - DECISION_EVENT_WINDOW),
    DECISION_EVENT_WINDOW,
  );
  const orderedEvents = [...events].sort((left, right) => left.id - right.id);
  const generationMetadataEvents = task.lastEventId > 0
    ? await deps.db.readEvents(
        task.agentSessionId,
        0,
        GENERATION_METADATA_READ_LIMIT,
        ["metadata"],
        undefined,
        ["persistent_generation"],
        "desc",
      )
    : [];
  const contextUsage = latestContextUsage(orderedEvents);
  const catalogDefaults = deps.modelCatalog.snapshot().persistent_defaults;
  const settings = readStoredPersistentSettings(
    task.metadata,
    catalogDefaults.fallback_models,
  );
  const currentPreset = task.modelPreset!;
  const defaultModel = settings?.default_model?.model_preset ?? currentPreset;
  const fallbackModels = (settings?.fallback_models ?? catalogDefaults.fallback_models)
    .map((selection) => selection.model_preset);
  const presetProviders: Record<string, DecisionProvider> = {};
  presetProviders[currentPreset] = providerForPreset(currentPreset, deps.modelCatalog);
  presetProviders[defaultModel] = providerForPreset(defaultModel, deps.modelCatalog);
  const supportedFallbackModels: string[] = [];
  for (const preset of fallbackModels) {
    let resolved: { backend: string; provider: DecisionProvider | undefined };
    try {
      resolved = resolveProvider(preset, deps.modelCatalog);
    } catch (error) {
      if (!(error instanceof UnknownModelPresetError)) throw error;
      deps.logger.warn(
        { sessionId: task.agentSessionId, preset, backend: "unknown" },
        "persistent decision skipped unsupported fallback preset",
      );
      continue;
    }
    if (resolved.provider === undefined) {
      deps.logger.warn(
        { sessionId: task.agentSessionId, preset, backend: resolved.backend },
        "persistent decision skipped unsupported fallback preset",
      );
      continue;
    }
    presetProviders[preset] = resolved.provider;
    supportedFallbackModels.push(preset);
  }
  const checkpointTokens = collectCheckpointTokensByPreset(
    task,
    [...generationMetadataEvents].sort((left, right) => left.id - right.id),
  );
  const lastComplete = [...orderedEvents].reverse().find((event) => event.event_type === "complete");
  const lastCallEndedAt = options.lastCallEndedAt
    ?? lastComplete?.created_at.toISOString()
    ?? task.completedAt?.toISOString()
    ?? now.toISOString();
  const accounts = await collectAccounts(
    task.agentSessionId,
    now,
    trigger === "limit_hit",
    [...new Set(Object.values(presetProviders))],
    deps.providerUsage,
    deps.logger,
  );
  const catalog = deps.modelCatalog.snapshot();
  const generationCosts: Record<string, GenerationCostProfile | undefined> = {};
  const cacheFractions: Record<string, number | null> = {};
  const idle = (now.getTime() - Date.parse(lastCallEndedAt)) / 1000;
  for (const [preset, provider] of Object.entries(presetProviders)) {
    if (provider !== "antigravity") continue;
    const model = deps.modelCatalog.resolve(preset).model;
    const row = findModelRow(catalog, model);
    const rates = row?.provider === "antigravity" ? row.rates : null;
    if (!rates?.input || rates.cache_read === null || rates.output === null) continue;
    const read = rates.cache_read / rates.input;
    const out = rates.output / rates.input;
    const seed = GENERATION_COST_SEEDS[preset as keyof typeof GENERATION_COST_SEEDS];
    const states = [...generationMetadataEvents].sort((a, b) => b.id - a.id)
      .map(event => extractPersistentGeneration([{ type: "persistent_generation", value: event.payload.value }]));
    if (task.persistentGeneration) states.unshift(task.persistentGeneration);
    const measured = states.map(state => state?.bootstrap).find(b =>
      b?.status === "complete" && !b.contextReset && b.modelPreset === preset && b.model === model
      && b.firstTurnContextTokens !== null && b.firstTurnContextTokens > 0 && b.initInputTokens !== null && b.initInputTokens > 0
      && b.initCachedTokens !== null && b.initCachedTokens <= b.initInputTokens
      && b.initOutputTokens !== null && b.initReasoningTokens !== null);
    const growthEntry = task.metadata?.find(entry => entry.type === "persistent_generation_growth");
    const growthValue = asRecord(growthEntry?.value);
    const growthPreset = asRecord(asRecord(growthValue?.presets)?.[preset]);
    const growthTokens = growthPreset?.tokens;
    const growthSamples = growthPreset?.samples;
    const bootstraps = new Map<number, NonNullable<NonNullable<typeof states[number]>["bootstrap"]>>();
    for (const state of states) {
      const b = state?.bootstrap;
      if (b?.status === "complete" && !b.contextReset && b.modelPreset === preset && b.model === model
        && b.growthTokens !== null && b.growthSamples !== null && b.growthSamples > 0
        && !bootstraps.has(b.generation)) bootstraps.set(b.generation, b);
    }
    const bootstrapTotals = [...bootstraps.values()].reduce(
      (sum, b) => ({ tokens: sum.tokens + b.growthTokens!, samples: sum.samples + b.growthSamples! }),
      { tokens: 0, samples: 0 },
    );
    const growth = growthPreset?.model === model && typeof growthTokens === "number" && Number.isFinite(growthTokens)
      && growthTokens >= 0 && typeof growthSamples === "number" && Number.isFinite(growthSamples) && growthSamples > 0
      ? growthTokens / growthSamples
      : bootstrapTotals.samples > 0 ? bootstrapTotals.tokens / bootstrapTotals.samples
      : seed?.growthTokensPerCall;
    if (measured) {
      if (growth !== undefined) generationCosts[preset] = {
        baselineTokens: measured.firstTurnContextTokens!,
        initEquivalentInputTokens: measured.initInputTokens! - (1 - read) * measured.initCachedTokens!
          + out * (measured.initOutputTokens! + measured.initReasoningTokens!),
        growthTokensPerCall: growth, readMultiplier: read,
        source: "session-bootstrap", sampleCount: typeof growthSamples === "number" ? growthSamples : 0,
        priceVersion: catalog.price_snapshot.price_version,
      };
    } else if (seed) {
      generationCosts[preset] = {
        baselineTokens: seed.baselineTokens,
        initEquivalentInputTokens: seed.input - (1 - read) * seed.cached + out * (seed.output + seed.reasoning),
        growthTokensPerCall: growth ?? seed.growthTokensPerCall, readMultiplier: read,
        source: seed.source, sampleCount: seed.sampleCount, priceVersion: catalog.price_snapshot.price_version,
      };
    }
    cacheFractions[preset] = firstCallCacheEstimate(preset, idle).fraction;
  }

  return {
    trigger,
    now: now.toISOString(),
    context_tokens: task.claudeContextUsage?.usedTokens ?? contextUsage?.usedTokens ?? 0,
    context_estimated: contextUsage?.estimated ?? false,
    last_call_ended_at: lastCallEndedAt,
    keepalive_count: countKeepalivesSinceHumanInput(orderedEvents),
    current_preset: currentPreset,
    default_model: defaultModel,
    fallback_models: supportedFallbackModels,
    preset_providers: presetProviders,
    checkpoint_tokens_by_preset: checkpointTokens,
    generation_cost_by_preset: generationCosts,
    first_call_cache_fraction_by_preset: cacheFractions,
    context_max_tokens: task.claudeContextUsage?.maxTokens ?? contextUsage?.maxTokens ?? 1_000_000,
    accounts,
    ...(options.limitResetAt ? { limit_reset_at: options.limitResetAt } : {}),
  };
}

export function countKeepalivesSinceHumanInput(
  events: readonly { event_type: string; payload: Record<string, unknown> }[],
): number {
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!INPUT_EVENT_TYPES.has(event.event_type)) continue;
    const callerInfo = asRecord(event.payload.caller_info);
    if (typeof callerInfo?.source === "string" && HUMAN_SOURCES.has(callerInfo.source)) break;
    if (isCacheKeepaliveInput(event.payload)) count += 1;
  }
  return count;
}

function latestContextUsage(
  events: readonly { event_type: string; payload: Record<string, unknown> }[],
): { usedTokens: number; maxTokens?: number; estimated: boolean } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event_type !== "context_usage") continue;
    const usedTokens = event.payload.used_tokens;
    if (typeof usedTokens !== "number") continue;
    return {
      usedTokens,
      ...(typeof event.payload.max_tokens === "number" ? { maxTokens: event.payload.max_tokens } : {}),
      estimated: event.payload.estimated === true,
    };
  }
  return undefined;
}

function collectCheckpointTokensByPreset(
  task: Task,
  events: readonly { id: number; event_type: string; payload: Record<string, unknown> }[],
): Record<string, number | undefined> {
  const checkpoints: Record<string, number | undefined> = {};
  const measuredGenerations = new Set<number>();
  for (const event of events) {
    if (event.event_type !== "metadata" || event.payload.metadata_type !== "persistent_generation") {
      continue;
    }
    const value = asRecord(event.payload.value);
    const firstCall = asRecord(value?.first_call);
    const preset = firstCall?.model_preset;
    const inputTokens = firstCall?.input_tokens;
    if (
      firstCall?.context_reset !== true
      && typeof preset === "string"
      && typeof inputTokens === "number"
    ) {
      checkpoints[preset] = inputTokens;
      if (typeof firstCall?.generation === "number") {
        measuredGenerations.add(firstCall.generation);
      }
    }
  }
  const currentFirstCall = task.persistentGeneration?.firstCall;
  if (
    currentFirstCall
    && currentFirstCall.contextReset !== true
    && !measuredGenerations.has(currentFirstCall.generation)
  ) {
    checkpoints[currentFirstCall.modelPreset] = currentFirstCall.inputTokens;
  }
  return checkpoints;
}

async function collectAccounts(
  sessionId: string,
  now: Date,
  forceRefresh: boolean,
  providers: DecisionProvider[],
  providerUsage: ProviderUsageCommandHandler,
  logger: Pick<Logger, "warn">,
): Promise<DecisionInput["accounts"]> {
  const stale = providers.some((provider) => {
    const observation = readProviderUsageObservation(provider);
    return !isFreshObservation(observation?.observed_at ?? null, now)
      || (observation !== undefined && isExpiredPoolBlockObservation(observation.result, now));
  });
  if (forceRefresh || stale) {
    try {
      const response = await providerUsage.fetchUsage(
        `persistent-decision:${sessionId}`,
        "provider_usage_get",
      );
      if (!response.success) {
        logger.warn(
          { sessionId, failureKind: "provider_usage_refresh" },
          "persistent decision using the last provider usage observation",
        );
      }
    } catch {
      logger.warn(
        { sessionId, failureKind: "provider_usage_refresh" },
        "persistent decision using the last provider usage observation",
      );
    }
  }
  return Object.fromEntries(providers.flatMap((provider) => {
    const observation = readProviderUsageObservation(provider);
    return observation
      ? [[provider, toAccountObservation(observation.result, observation.result.observedAt ?? null, now)]]
      : [];
  }));
}

function isFreshObservation(observedAt: string | null, now: Date): boolean {
  return observedAt !== null
    && (now.getTime() - Date.parse(observedAt)) / 1_000 < DEFAULT_CONFIG.usage_refresh_seconds;
}

function toAccountObservation(
  result: Pick<ProviderLimits,
    | "weeklyUsedPercent"
    | "weeklyResetAt"
    | "shortUsedPercent"
    | "shortResetAt"
    | "mode"
    | "pool"
  >,
  observedAt: string | null,
  now: Date,
): AccountObservation {
  if (isExhaustedClaudePool(result, now)) {
    return {
      weekly_headroom: -100,
      weekly_remaining_percent: 0,
      short_remaining_percent: 0,
      short_reset_at: result.pool!.earliest_available_at,
      observed_at: observedAt ?? now.toISOString(),
    };
  }
  const weeklyHeadroom = result.weeklyUsedPercent === null || result.weeklyResetAt === null
    ? null
    : 100 - result.weeklyUsedPercent
      - ((result.weeklyResetAt - now.getTime() / 1_000) / (7 * 24 * 60 * 60)) * 100;
  return {
    weekly_headroom: weeklyHeadroom,
    weekly_remaining_percent: result.weeklyUsedPercent === null
      ? null
      : 100 - result.weeklyUsedPercent,
    short_remaining_percent: result.shortUsedPercent === null
      ? null
      : 100 - result.shortUsedPercent,
    short_reset_at: result.shortResetAt === null
      ? null
      : new Date(result.shortResetAt * 1_000).toISOString(),
    observed_at: observedAt,
  };
}

function isExhaustedClaudePool(
  result: Pick<ProviderLimits, "mode" | "pool">,
  now: Date,
): boolean {
  return result.mode === "pool"
    && result.pool !== undefined
    && result.pool.total_count > 0
    && result.pool.available_count === 0
    && (result.pool.earliest_available_at === null
      || Date.parse(result.pool.earliest_available_at) > now.getTime());
}

function isExpiredPoolBlockObservation(
  result: Pick<ProviderLimits, "mode" | "pool">,
  now: Date,
): boolean {
  return result.mode === "pool"
    && result.pool !== undefined
    && result.pool.total_count > 0
    && result.pool.available_count === 0
    && result.pool.earliest_available_at !== null
    && Date.parse(result.pool.earliest_available_at) <= now.getTime();
}

function providerForPreset(
  preset: string,
  modelCatalog: Pick<ModelCatalog, "resolve">,
): DecisionProvider {
  const { backend, provider } = resolveProvider(preset, modelCatalog);
  if (provider === undefined) {
    throw new Error(`Persistent decision does not support preset backend: ${backend}`);
  }
  return provider;
}

function resolveProvider(
  preset: string,
  modelCatalog: Pick<ModelCatalog, "resolve">,
): { backend: string; provider: DecisionProvider | undefined } {
  const backend = modelCatalog.resolve(preset).backend;
  return {
    backend,
    provider: backend === "claude" || backend === "codex" || backend === "antigravity"
      ? backend
      : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function completeEventEndedAt(event: SSEEventPayload): string | undefined {
  const timestamp = (event as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? new Date(timestamp * 1_000).toISOString()
    : undefined;
}
