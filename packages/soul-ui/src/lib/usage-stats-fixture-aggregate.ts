// Pure aggregation helpers shared by the public synthetic fixture builders.
import type {
  MissingTurnRecord,
  PendingTurnRecord,
  RawUsageRecord,
  UsageStatsAggregate,
  UsageStatsCoverage,
  UsageStatsMetrics,
  UsageStatsQuery,
} from "./usage-stats-fixture-data";
import { MISSING_TURNS, PENDING_TURNS, USAGE_STATS_COLLECTION } from "./usage-stats-fixture-data";

export function aggregateFixtureUsage(
  records: RawUsageRecord[], missing: MissingTurnRecord[], pending: PendingTurnRecord[],
  countMissing: boolean, query: Partial<UsageStatsQuery>, since: string, until: string,
): UsageStatsAggregate {
  const value = aggregate(records, missing, pending, countMissing);
  const collection = USAGE_STATS_COLLECTION;
  const covered = since >= collection.since && until <= collection.until && since < until;
  const providerCovered = query.provider ? collection.providers[query.provider] === "complete" : !query.model;
  const inScope = (turn: { date: string; project_id: string | null }) => turn.date >= since && turn.date < until &&
    (!query.project_ids?.length || query.project_ids.some(id => id === turn.project_id || (id === "__unclassified__" && turn.project_id === null)));
  const unidentified = [MISSING_TURNS, PENDING_TURNS].some(turns => turns.some(inScope));
  // Missing turns have no provider/model attribution; preserve that uncertainty
  // without assigning their numeric counts to any filtered provider or model.
  value.coverage.unattributed_missing_usage = Boolean(query.provider || query.model) && MISSING_TURNS.some(inScope);
  if (value.coverage.unattributed_missing_usage) value.is_partial = true;
  if (!records.length && covered && providerCovered && !unidentified) {
    return { metrics: zeroMetrics(), coverage: zeroCoverage(), is_partial: false };
  }
  // A known zero event is not evidence that unidentified turns also used zero.
  if (value.metrics.total_tokens === 0 && unidentified) {
    value.metrics.total_tokens = null;
    value.metrics.reference_cost_usd = null;
    value.is_partial = true;
  }
  return value;
}

export function aggregate(
  records: RawUsageRecord[],
  missing: MissingTurnRecord[],
  pending: PendingTurnRecord[],
  countMissing: boolean,
): UsageStatsAggregate {
  const metrics = aggregateMetrics(records);
  let complete = 0;
  let partial = 0;
  let terminal = 0;
  let ended = 0;
  let priced = 0;
  let unpriced = 0;
  let unknown = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let hasPricedTokens = false;
  let hasUnpricedTokens = false;
  const countedIds: string[] = [];

  for (const record of records) {
    const hasInput = typeof record.input_total === "number";
    const hasOutput = typeof record.output_total === "number";
    if (hasInput && hasOutput) complete += 1;
    else partial += 1;
    if (!hasInput || !hasOutput) unknown += 1;

    const eventTokens = hasInput && hasOutput ? record.input_total! + record.output_total! : null;
    if (record.reference_cost_usd === null) {
      unpriced += 1;
      if (eventTokens !== null) {
        unpricedTokens += eventTokens;
        hasUnpricedTokens = true;
      }
    } else {
      priced += 1;
      if (eventTokens !== null) {
        pricedTokens += eventTokens;
        hasPricedTokens = true;
      }
    }
  }

  for (const turn of missing) {
    if (turn.terminal) terminal += 1;
    if (turn.ended) ended += 1;
    if (countMissing && countedIds.indexOf(turn.id) < 0) countedIds.push(turn.id);
  }
  if (metrics.total_tokens === 0 && (missing.length > 0 || pending.length > 0)) {
    metrics.total_tokens = null;
    metrics.reference_cost_usd = null;
  }

  const coverage: UsageStatsCoverage = {
    usage_complete_events: complete,
    usage_partial_events: partial,
    terminal_missing_usage: terminal,
    ended_input_without_usage: ended,
    missing_usage_turns: countedIds.length,
    pending_inputs: pending.length,
    priced_events: priced,
    unpriced_events: unpriced,
    priced_total_tokens: hasPricedTokens ? pricedTokens : null,
    unpriced_total_tokens: hasUnpricedTokens ? unpricedTokens : null,
    unknown_total_token_events: unknown,
    unattributed_missing_usage: false,
  };
  return {
    metrics,
    coverage,
    is_partial: partial > 0 || unknown > 0 || countedIds.length > 0 || unpriced > 0 || records.length === 0,
  };
}

export function aggregateMetrics(records: RawUsageRecord[]): UsageStatsMetrics {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning = 0;
  let cost = 0;
  let knownInput = false;
  let knownCacheRead = false;
  let knownCacheWrite = false;
  let knownOutput = false;
  let knownReasoning = false;
  let knownCost = false;
  let totalTokens = 0;
  let knownTokens = false;

  for (const record of records) {
    if (record.input_total !== null) { input += record.input_total; knownInput = true; }
    if (record.cache_read !== null) { cacheRead += record.cache_read; knownCacheRead = true; }
    if (record.cache_write !== null) { cacheWrite += record.cache_write; knownCacheWrite = true; }
    if (record.output_total !== null) { output += record.output_total; knownOutput = true; }
    if (record.reasoning_output !== null) { reasoning += record.reasoning_output; knownReasoning = true; }
    if (record.reference_cost_usd !== null) { cost += record.reference_cost_usd; knownCost = true; }
    if (record.input_total !== null && record.output_total !== null) {
      totalTokens += record.input_total + record.output_total;
      knownTokens = true;
    }
  }

  return {
    input_total: knownInput ? input : null,
    cache_read: knownCacheRead ? cacheRead : null,
    cache_write: knownCacheWrite ? cacheWrite : null,
    output_total: knownOutput ? output : null,
    reasoning_output: knownReasoning ? reasoning : null,
    total_tokens: knownTokens ? totalTokens : null,
    reference_cost_usd: knownCost ? cost : null,
  };
}

export function hasUnknownPrice(records: RawUsageRecord[]): boolean {
  for (const record of records) if (record.reference_cost_usd === null) return true;
  return false;
}

export function zeroMetrics(): UsageStatsMetrics {
  return {
    input_total: 0,
    cache_read: 0,
    cache_write: 0,
    output_total: 0,
    reasoning_output: 0,
    total_tokens: 0,
    reference_cost_usd: 0,
  };
}

export function zeroCoverage(): UsageStatsCoverage {
  return {
    usage_complete_events: 0,
    usage_partial_events: 0,
    terminal_missing_usage: 0,
    ended_input_without_usage: 0,
    missing_usage_turns: 0,
    pending_inputs: 0,
    priced_events: 0,
    unpriced_events: 0,
    priced_total_tokens: 0,
    unpriced_total_tokens: 0,
    unknown_total_token_events: 0,
    unattributed_missing_usage: false,
  };
}
