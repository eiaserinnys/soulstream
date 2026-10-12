import type { TurnUsageSessionRow } from "../control_plane/repositories/turn_usage_repository.js";

type SumKey =
  | "input_tokens"
  | "cached_input_tokens"
  | "cache_write_tokens"
  | "output_tokens"
  | "cost_usd";

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
  const totals = {
    sessions: rows.length,
    new_sessions: newRows.length,
    turns: rows.reduce((sum, row) => sum + row.turns, 0),
    turns_without_usage: rows.reduce((sum, row) => sum + row.turns_without_usage, 0),
    ...sumMeasures(rows, ["input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd"]),
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
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || a.session_id.localeCompare(b.session_id))
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
    }));

  return { totals, by_agent_model, top_sessions };
}

function sumMeasures<K extends SumKey>(rows: readonly TurnUsageSessionRow[], keys: readonly K[]) {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const present = rows.flatMap((row) => isNumber(row[key]) ? [row[key] as number] : []);
    if (present.length === 0) continue;
    const sum = present.reduce((total, value) => total + value, 0);
    result[key] = key === "cost_usd" ? roundCost(sum) : sum;
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
