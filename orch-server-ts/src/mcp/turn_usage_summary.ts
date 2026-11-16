import type { TurnUsageSessionRow } from "../control_plane/repositories/turn_usage_repository.js";
import type { TurnSubagentModelUsage } from "../control_plane/repositories/turn_usage_subagents.js";

type SumKey =
  | "input_tokens"
  | "cached_input_tokens"
  | "cache_write_tokens"
  | "output_tokens"
  | "cost_usd"
  | "subagent_input_tokens"
  | "subagent_cached_input_tokens"
  | "subagent_cache_write_tokens"
  | "subagent_output_tokens"
  | "subagent_cost_usd";

const SUBAGENT_KEYS = [
  "subagent_input_tokens",
  "subagent_cached_input_tokens",
  "subagent_cache_write_tokens",
  "subagent_output_tokens",
  "subagent_cost_usd",
] as const;

type GroupedUsage = {
  agent_id?: string;
  model?: string;
  sessions: number;
  new_sessions: number;
  turns: number;
  turns_without_usage: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  injection_chars_median?: number;
  injection_chars_max?: number;
  first_call_input_median?: number;
};

type TopSession = {
  session_id: string;
  name?: string;
  agent_id?: string;
  node_id?: string;
  model?: string;
  turns: number;
  turns_without_usage: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  injection_chars?: number;
  first_call_input_tokens?: number;
  subagent_input_tokens?: number;
  subagent_output_tokens?: number;
  subagent_cost_usd?: number;
  total_cost_usd?: number;
};

type SubagentModelGroup = {
  agent_id?: string;
  model: string;
  sessions: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd?: number;
};

type SubagentGroupAccumulator = {
  agent_id?: string;
  model: string;
  sessions: Set<string>;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd?: number;
};

export function summarizeTurnUsage(
  rows: readonly TurnUsageSessionRow[],
  since: string,
  until: string,
) {
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const isNew = (row: TurnUsageSessionRow) => {
    if (!row.created_at) return false;
    const createdMs = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(row.created_at);
    return Number.isFinite(createdMs) && createdMs >= sinceMs && createdMs < untilMs;
  };
  const newRows = rows.filter(isNew);
  const subagentRows = rows.filter(hasSubagentUsage);
  const mainCost = sumMeasures(rows, ["cost_usd"]).cost_usd ?? 0;
  const subagentCost = sumMeasures(subagentRows, ["subagent_cost_usd"]).subagent_cost_usd ?? 0;
  const totals = {
    sessions: rows.length,
    new_sessions: newRows.length,
    turns: rows.reduce((sum, row) => sum + row.turns, 0),
    turns_without_usage: rows.reduce((sum, row) => sum + row.turns_without_usage, 0),
    ...sumMeasures(rows, ["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd"]),
    ...(subagentRows.length > 0 ? {
      ...sumMeasures(subagentRows, SUBAGENT_KEYS),
      total_cost_usd: roundCost(mainCost + subagentCost),
    } : {}),
  };

  const grouped = new Map<string, TurnUsageSessionRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.agent_id ?? null, row.model ?? null]);
    const groupRows = grouped.get(key) ?? [];
    groupRows.push(row);
    grouped.set(key, groupRows);
  }
  const by_agent_model: GroupedUsage[] = [...grouped.values()].map((groupRows) => {
    const groupNewRows = groupRows.filter(isNew);
    const injections = groupNewRows.flatMap((row) => isNumber(row.injection_chars) ? [row.injection_chars] : []);
    const firstCalls = groupNewRows.flatMap((row) => isNumber(row.first_call_input_tokens) ? [row.first_call_input_tokens] : []);
    return {
      ...(groupRows[0]?.agent_id ? { agent_id: groupRows[0].agent_id } : {}),
      ...(groupRows[0]?.model ? { model: groupRows[0].model } : {}),
      sessions: groupRows.length,
      new_sessions: groupNewRows.length,
      turns: groupRows.reduce((sum, row) => sum + row.turns, 0),
      turns_without_usage: groupRows.reduce((sum, row) => sum + row.turns_without_usage, 0),
      ...sumMeasures(groupRows, ["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd"]),
      ...(injections.length > 0 ? {
        injection_chars_median: median(injections),
        injection_chars_max: Math.max(...injections),
      } : {}),
      ...(firstCalls.length > 0 ? { first_call_input_median: median(firstCalls) } : {}),
    };
  }).sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0));

  const top_sessions: TopSession[] = [...rows]
    .sort((a, b) => combinedCost(b) - combinedCost(a) || a.session_id.localeCompare(b.session_id))
    .slice(0, 20)
    .map((row) => ({
      session_id: row.session_id,
      ...(row.display_name ? { name: row.display_name } : {}),
      ...(row.agent_id ? { agent_id: row.agent_id } : {}),
      ...(row.node_id ? { node_id: row.node_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      turns: row.turns,
      turns_without_usage: row.turns_without_usage,
      ...sumMeasures([row], ["input_tokens", "cached_input_tokens", "output_tokens", "cost_usd"]),
      ...(isNumber(row.injection_chars) ? { injection_chars: row.injection_chars } : {}),
      ...(isNew(row) && isNumber(row.first_call_input_tokens)
        ? { first_call_input_tokens: row.first_call_input_tokens }
        : {}),
      ...(hasSubagentUsage(row) ? {
        ...sumMeasures([row], ["subagent_input_tokens", "subagent_output_tokens", "subagent_cost_usd"]),
        total_cost_usd: roundCost((row.cost_usd ?? 0) + (row.subagent_cost_usd ?? 0)),
      } : {}),
    }));

  const subagents_by_agent_model = subagentModelGroups(rows);

  return {
    totals,
    by_agent_model,
    top_sessions,
    ...(subagents_by_agent_model.length > 0 ? { subagents_by_agent_model } : {}),
  };
}

function combinedCost(row: TurnUsageSessionRow): number {
  return (row.cost_usd ?? 0) + (row.subagent_cost_usd ?? 0);
}

function hasSubagentUsage(row: TurnUsageSessionRow): boolean {
  if ((row.subagent_models?.length ?? 0) > 0) return true;
  return SUBAGENT_KEYS.some((key) => isNumber(row[key]));
}

function subagentModelGroups(rows: readonly TurnUsageSessionRow[]): SubagentModelGroup[] {
  const groups = new Map<string, SubagentGroupAccumulator>();
  for (const row of rows) {
    for (const model of row.subagent_models ?? []) {
      const key = JSON.stringify([row.agent_id ?? null, model.model]);
      const group = groups.get(key) ?? {
        ...(row.agent_id ? { agent_id: row.agent_id } : {}),
        model: model.model,
        sessions: new Set<string>(),
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
      };
      group.sessions.add(row.session_id);
      addModelUsage(group, model);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...(group.agent_id ? { agent_id: group.agent_id } : {}),
      model: group.model,
      sessions: group.sessions.size,
      input_tokens: group.input_tokens,
      cached_input_tokens: group.cached_input_tokens,
      cache_write_tokens: group.cache_write_tokens,
      output_tokens: group.output_tokens,
      ...(group.cost_usd === undefined ? {} : { cost_usd: roundCost(group.cost_usd) }),
    }))
    .sort((a, b) =>
      (b.cost_usd ?? 0) - (a.cost_usd ?? 0) ||
      a.model.localeCompare(b.model) ||
      (a.agent_id ?? "").localeCompare(b.agent_id ?? ""));
}

function addModelUsage(group: SubagentGroupAccumulator, model: TurnSubagentModelUsage): void {
  group.input_tokens += model.input_tokens;
  group.cached_input_tokens += model.cached_input_tokens;
  group.cache_write_tokens += model.cache_write_tokens;
  group.output_tokens += model.output_tokens;
  if (model.cost_usd !== undefined) {
    group.cost_usd = (group.cost_usd ?? 0) + model.cost_usd;
  }
}

function sumMeasures<K extends SumKey>(rows: readonly TurnUsageSessionRow[], keys: readonly K[]) {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const present = rows.flatMap((row) => isNumber(row[key]) ? [row[key] as number] : []);
    if (present.length === 0) continue;
    const sum = present.reduce((total, value) => total + value, 0);
    result[key] = key === "cost_usd" || key === "subagent_cost_usd" ? roundCost(sum) : sum;
  }
  return result;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
