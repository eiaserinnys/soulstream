/**
 * Claude CLI's `model_usage` accumulates for the lifetime of the CLI process:
 * it holds the main session plus every subagent that ran in that process.
 * Turn usage reads therefore diff consecutive cumulative snapshots and then
 * subtract the main session's own usage for the turn.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findModelRow,
  parseModelCatalogYaml,
  type ModelCatalogConfig,
} from "@soulstream/model-catalog";
import { modelCatalogPathForRepository } from "@soulstream/model-catalog/file-loader";
import { priceInferenceUsage } from "@soulstream/model-catalog/inference-pricing";

export interface TurnSubagentModelUsage {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

export interface TurnSubagentRollup {
  subagent_input_tokens: number;
  subagent_cached_input_tokens: number;
  subagent_cache_write_tokens: number;
  subagent_output_tokens: number;
  subagent_cost_usd?: number;
  subagent_models: TurnSubagentModelUsage[];
}

export interface TurnSubagentUsageTurn {
  event_id: number;
  model?: string | null;
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  cache_write_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  model_usage?: unknown;
}

interface RawModelUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd?: number;
  model: string;
}

type ModelUsageSnapshot = Map<string, RawModelUsage>;

interface ModelBucket {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

const COST_EPSILON = 0.000005;
const TOKEN_EPSILON = 1e-6;
/** Ancestor levels searched from this module for the repository catalogue. */
const MAX_CATALOG_ANCESTOR_STEPS = 8;

/** `null` means the catalogue was searched for and not found. */
let defaultModelCatalog: ModelCatalogConfig | null | undefined;

/**
 * The repository catalogue, resolved from this module's location so it works
 * both from `src/` (tests, tsx) and from the bundled `dist/` entries.
 */
function loadDefaultModelCatalog(): ModelCatalogConfig | undefined {
  if (defaultModelCatalog !== undefined) return defaultModelCatalog ?? undefined;
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step <= MAX_CATALOG_ANCESTOR_STEPS; step += 1) {
    const candidate = modelCatalogPathForRepository(directory);
    if (fs.existsSync(candidate)) {
      defaultModelCatalog = parseModelCatalogYaml(fs.readFileSync(candidate, "utf8"));
      return defaultModelCatalog;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  defaultModelCatalog = null;
  return undefined;
}

export function computeSessionSubagentRollups(
  turns: readonly TurnSubagentUsageTurn[],
  catalog: ModelCatalogConfig | undefined = loadDefaultModelCatalog(),
): Map<number, TurnSubagentRollup> {
  const rollups = new Map<number, TurnSubagentRollup>();
  let previous: ModelUsageSnapshot | null = null;

  for (const turn of turns) {
    const current = parseModelUsage(turn.model_usage);
    if (current === undefined) continue;

    const restarted = isCliRestart(previous, current, finiteNumber(turn.output_tokens) ?? 0);
    const base = restarted ? null : previous;
    previous = current;

    // Failed result events carry usage and model_usage but no model. Advance the
    // cumulative base without emitting a rollup so their main usage is not counted
    // as subagent consumption.
    const mainModel = typeof turn.model === "string" ? normalizeModelName(turn.model) : undefined;
    if (mainModel === undefined) continue;

    const buckets = new Map<string, ModelBucket>();
    for (const [rawKey, entry] of current) {
      const previousEntry = base?.get(rawKey);
      const bucket = buckets.get(entry.model) ?? {
        model: entry.model,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
      };
      const deltaUncached = entry.input_tokens - (previousEntry?.input_tokens ?? 0);
      const deltaCacheRead = entry.cached_input_tokens - (previousEntry?.cached_input_tokens ?? 0);
      const deltaCacheWrite = entry.cache_write_tokens - (previousEntry?.cache_write_tokens ?? 0);
      bucket.input_tokens += deltaUncached + deltaCacheRead + deltaCacheWrite;
      bucket.cached_input_tokens += deltaCacheRead;
      bucket.cache_write_tokens += deltaCacheWrite;
      bucket.output_tokens += entry.output_tokens - (previousEntry?.output_tokens ?? 0);
      if (entry.cost_usd !== undefined) {
        bucket.cost_usd = (bucket.cost_usd ?? 0) + entry.cost_usd - (previousEntry?.cost_usd ?? 0);
      }
      buckets.set(entry.model, bucket);
    }

    const mainBucket = buckets.get(mainModel);
    const mainHasTokens =
      (finiteNumber(turn.input_tokens) ?? 0) > 0 || (finiteNumber(turn.output_tokens) ?? 0) > 0;
    if (mainBucket === undefined && mainHasTokens) continue;
    if (mainBucket) {
      mainBucket.input_tokens = clampToken(mainBucket.input_tokens - (finiteNumber(turn.input_tokens) ?? 0));
      mainBucket.cached_input_tokens = clampToken(
        mainBucket.cached_input_tokens - (finiteNumber(turn.cached_input_tokens) ?? 0),
      );
      mainBucket.cache_write_tokens = clampToken(
        mainBucket.cache_write_tokens - (finiteNumber(turn.cache_write_tokens) ?? 0),
      );
      mainBucket.output_tokens = clampToken(mainBucket.output_tokens - (finiteNumber(turn.output_tokens) ?? 0));
      if (mainBucket.cost_usd !== undefined) {
        const difference = mainBucket.cost_usd - (finiteNumber(turn.cost_usd) ?? 0);
        mainBucket.cost_usd = difference <= COST_EPSILON ? 0 : roundCost(difference);
      }
    }
    if (catalog !== undefined) {
      for (const bucket of buckets.values()) repriceFromCatalog(catalog, bucket);
    }

    const models = [...buckets.values()]
      .filter(hasTokens)
      .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || a.model.localeCompare(b.model))
      .map((bucket) => ({
        model: bucket.model,
        input_tokens: bucket.input_tokens,
        cached_input_tokens: bucket.cached_input_tokens,
        cache_write_tokens: bucket.cache_write_tokens,
        output_tokens: bucket.output_tokens,
        ...(bucket.cost_usd === undefined ? {} : { cost_usd: bucket.cost_usd }),
      }));
    if (models.length === 0) continue;

    const costs = models.flatMap((model) => model.cost_usd === undefined ? [] : [model.cost_usd]);
    rollups.set(turn.event_id, {
      subagent_input_tokens: sum(models.map((model) => model.input_tokens)),
      subagent_cached_input_tokens: sum(models.map((model) => model.cached_input_tokens)),
      subagent_cache_write_tokens: sum(models.map((model) => model.cache_write_tokens)),
      subagent_output_tokens: sum(models.map((model) => model.output_tokens)),
      ...(costs.length === 0 ? {} : { subagent_cost_usd: roundCost(sum(costs)) }),
      subagent_models: models,
    });
  }

  return rollups;
}

export function aggregateSubagentRollups(
  rollups: Iterable<TurnSubagentRollup>,
): TurnSubagentRollup | undefined {
  const models = new Map<string, ModelBucket>();
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  let seen = false;

  for (const rollup of rollups) {
    seen = true;
    inputTokens += rollup.subagent_input_tokens;
    cachedInputTokens += rollup.subagent_cached_input_tokens;
    cacheWriteTokens += rollup.subagent_cache_write_tokens;
    outputTokens += rollup.subagent_output_tokens;
    if (rollup.subagent_cost_usd !== undefined) {
      costUsd += rollup.subagent_cost_usd;
      hasCost = true;
    }
    for (const model of rollup.subagent_models) {
      const bucket = models.get(model.model) ?? {
        model: model.model,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
      };
      bucket.input_tokens += model.input_tokens;
      bucket.cached_input_tokens += model.cached_input_tokens;
      bucket.cache_write_tokens += model.cache_write_tokens;
      bucket.output_tokens += model.output_tokens;
      if (model.cost_usd !== undefined) {
        bucket.cost_usd = (bucket.cost_usd ?? 0) + model.cost_usd;
      }
      models.set(model.model, bucket);
    }
  }
  if (!seen) return undefined;

  return {
    subagent_input_tokens: inputTokens,
    subagent_cached_input_tokens: cachedInputTokens,
    subagent_cache_write_tokens: cacheWriteTokens,
    subagent_output_tokens: outputTokens,
    ...(hasCost ? { subagent_cost_usd: roundCost(costUsd) } : {}),
    subagent_models: [...models.values()]
      .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || a.model.localeCompare(b.model))
      .map((bucket) => ({
        model: bucket.model,
        input_tokens: bucket.input_tokens,
        cached_input_tokens: bucket.cached_input_tokens,
        cache_write_tokens: bucket.cache_write_tokens,
        output_tokens: bucket.output_tokens,
        ...(bucket.cost_usd === undefined ? {} : { cost_usd: roundCost(bucket.cost_usd) }),
      })),
  };
}

/**
 * Claude Code prices a non-Claude endpoint with Claude rates, so the CLI cost of
 * a bucket driven through that endpoint carries the difference against the main
 * turn's catalogue price. Re-price the bucket from the catalogue when its row
 * names another provider; an unpriced row keeps its tokens and drops the cost.
 */
function repriceFromCatalog(catalog: ModelCatalogConfig, bucket: ModelBucket): void {
  if (!hasTokens(bucket)) return;
  const provider = findModelRow(catalog, bucket.model)?.provider;
  if (provider === undefined || provider === "claude") return;
  const priced = priceInferenceUsage(catalog, {
    provider,
    model: bucket.model,
    input_total: bucket.input_tokens,
    cache_read: bucket.cached_input_tokens,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_write_unknown: provider === "deepseek" ? 0 : bucket.cache_write_tokens,
    output_total: bucket.output_tokens,
  });
  if (priced.pricing_complete && priced.known_cost_usd !== null) {
    bucket.cost_usd = roundCost(priced.known_cost_usd);
  } else {
    delete bucket.cost_usd;
  }
}

function hasTokens(bucket: ModelBucket): boolean {
  return bucket.input_tokens > 0 || bucket.output_tokens > 0;
}

export function normalizeModelName(model: string): string {
  return model.replace(/\[[^\]]+\]$/, "");
}

function parseModelUsage(value: unknown): ModelUsageSnapshot | undefined {
  if (!isPlainObject(value)) return undefined;
  const snapshot: ModelUsageSnapshot = new Map();
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const entry = isPlainObject(rawEntry) ? rawEntry : {};
    const canonical = typeof entry.canonicalModel === "string"
      ? entry.canonicalModel
      : typeof entry.canonical_model === "string"
        ? entry.canonical_model
        : rawKey;
    const costUsd = finiteNonNegative(entry.costUSD ?? entry.cost_usd);
    snapshot.set(rawKey, {
      input_tokens: finiteNonNegative(entry.inputTokens ?? entry.input_tokens) ?? 0,
      cached_input_tokens: finiteNonNegative(
        entry.cacheReadInputTokens ?? entry.cache_read_input_tokens,
      ) ?? 0,
      cache_write_tokens: finiteNonNegative(
        entry.cacheCreationInputTokens ?? entry.cache_creation_input_tokens ?? entry.cache_write_input_tokens,
      ) ?? 0,
      output_tokens: finiteNonNegative(entry.outputTokens ?? entry.output_tokens) ?? 0,
      ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
      model: normalizeModelName(canonical),
    });
  }
  return snapshot;
}

function isCliRestart(
  previous: ModelUsageSnapshot | null,
  current: ModelUsageSnapshot,
  turnOutputTokens: number,
): boolean {
  if (previous === null) return true;
  for (const rawKey of previous.keys()) {
    if (!current.has(rawKey)) return true;
  }
  for (const [rawKey, previousEntry] of previous) {
    const currentEntry = current.get(rawKey);
    if (!currentEntry) return true;
    if (decreased(currentEntry.input_tokens, previousEntry.input_tokens)) return true;
    if (decreased(currentEntry.cached_input_tokens, previousEntry.cached_input_tokens)) return true;
    if (decreased(currentEntry.cache_write_tokens, previousEntry.cache_write_tokens)) return true;
    if (decreased(currentEntry.output_tokens, previousEntry.output_tokens)) return true;
    if (currentEntry.cost_usd !== undefined && previousEntry.cost_usd !== undefined
      && decreased(currentEntry.cost_usd, previousEntry.cost_usd)) return true;
  }
  let outputDelta = 0;
  for (const [rawKey, currentEntry] of current) {
    outputDelta += currentEntry.output_tokens - (previous.get(rawKey)?.output_tokens ?? 0);
  }
  return outputDelta < turnOutputTokens - TOKEN_EPSILON;
}

function decreased(current: number, previous: number): boolean {
  return current < previous - TOKEN_EPSILON;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampToken(value: number): number {
  return value > 0 ? value : 0;
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
