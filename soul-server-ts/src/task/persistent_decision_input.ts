import type { Logger } from "pino";

import {
  PERSISTENT_SETTINGS_DEFAULTS,
  readStoredPersistentSettings,
} from "@soulstream/wire-schema/persistent-session-settings";

import {
  readProviderUsageObservation,
  type DecisionProvider,
} from "../auth/provider_usage_observation.js";
import type {
  ProviderLimits,
  ProviderUsageCommandHandler,
} from "../auth/provider_usage.js";
import { DEFAULT_CONFIG } from "./persistent_decision_config.js";
import type {
  AccountObservation,
  DecisionInput,
  DecisionTrigger,
} from "./persistent_decision.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { SessionDB } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "./task_models.js";
import { isCacheKeepaliveInput } from "./persistent_keepalive_marker.js";

const DECISION_EVENT_WINDOW = 200;
const HUMAN_SOURCES = new Set(["browser", "soul-app", "slack"]);
const INPUT_EVENT_TYPES = new Set(["user_message", "intervention_sent"]);

export interface PersistentDecisionInputDependencies {
  db: Pick<SessionDB, "readEvents">;
  modelCatalog: Pick<ModelCatalog, "resolve">;
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
    ? await deps.db.readEvents(task.agentSessionId, 0, task.lastEventId, ["metadata"])
    : [];
  const contextUsage = latestContextUsage(orderedEvents);
  const settings = readStoredPersistentSettings(task.metadata);
  const currentPreset = task.modelPreset!;
  const defaultModel = settings?.default_model?.model_preset ?? currentPreset;
  const fallbackModel = settings?.fallback_model?.model_preset
    ?? PERSISTENT_SETTINGS_DEFAULTS.fallback_model.model_preset;
  const presetProviders = Object.fromEntries(
    [...new Set([currentPreset, defaultModel, fallbackModel])].map((preset) => [
      preset,
      providerForPreset(preset, deps.modelCatalog),
    ]),
  );
  const checkpointTokens = collectCheckpointTokensByPreset(task, generationMetadataEvents);
  const lastComplete = [...orderedEvents].reverse().find((event) => event.event_type === "complete");
  const lastCallEndedAt = options.lastCallEndedAt
    ?? lastComplete?.created_at.toISOString()
    ?? task.completedAt?.toISOString()
    ?? now.toISOString();
  const accounts = await collectAccounts(
    task.agentSessionId,
    now,
    trigger === "limit_hit",
    deps.providerUsage,
    deps.logger,
  );

  return {
    trigger,
    now: now.toISOString(),
    context_tokens: task.claudeContextUsage?.usedTokens ?? contextUsage?.usedTokens ?? 0,
    context_estimated: contextUsage?.estimated ?? false,
    last_call_ended_at: lastCallEndedAt,
    keepalive_count: countKeepalivesSinceHumanInput(orderedEvents),
    current_preset: currentPreset,
    default_model: defaultModel,
    fallback_model: fallbackModel,
    preset_providers: presetProviders as Record<string, DecisionProvider>,
    checkpoint_tokens_by_preset: checkpointTokens,
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
): { usedTokens: number; estimated: boolean } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event_type !== "context_usage") continue;
    const usedTokens = event.payload.used_tokens;
    if (typeof usedTokens !== "number") continue;
    return {
      usedTokens,
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
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
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
  providerUsage: ProviderUsageCommandHandler,
  logger: Pick<Logger, "warn">,
): Promise<DecisionInput["accounts"]> {
  const providers: DecisionProvider[] = ["claude", "codex"];
  const stale = providers.some((provider) => !isFreshObservation(
    readProviderUsageObservation(provider)?.observed_at ?? null,
    now,
  ));
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
    "weeklyUsedPercent" | "weeklyResetAt" | "shortUsedPercent" | "shortResetAt">,
  observedAt: string | null,
  now: Date,
): AccountObservation {
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

function providerForPreset(
  preset: string,
  modelCatalog: Pick<ModelCatalog, "resolve">,
): DecisionProvider {
  const backend = modelCatalog.resolve(preset).backend;
  if (backend !== "claude" && backend !== "codex") {
    throw new Error(`Persistent decision does not support preset backend: ${backend}`);
  }
  return backend;
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
