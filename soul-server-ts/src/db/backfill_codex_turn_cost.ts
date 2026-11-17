import type { ModelCatalogConfig } from "@soulstream/model-catalog";
import { codexTurnCostUsd } from "../engine/list_price.js";

export interface BackfillEvent {
  session_id: string;
  id: number;
  event_type: string;
  payload: unknown;
}

export type ModelTotals = Record<string, { count: number; cost_usd: number }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function calculateBackfillCost(event: BackfillEvent, catalog: ModelCatalogConfig): number | undefined {
  if (event.event_type !== "complete" && event.event_type !== "error") return undefined;
  if (!isRecord(event.payload) || Object.hasOwn(event.payload, "turn_cost_usd")) return undefined;
  const { model, usage } = event.payload;
  if (typeof model !== "string" || !model || !isRecord(usage)) return undefined;
  return codexTurnCostUsd(catalog, usage as { input_tokens: number; cached_input_tokens: number; output_tokens: number }, model);
}

export async function processBackfillRows(
  rows: readonly BackfillEvent[],
  catalog: ModelCatalogConfig,
  apply: boolean,
  write: (event: BackfillEvent, cost: number) => Promise<boolean>,
): Promise<ModelTotals> {
  const totals: ModelTotals = {};
  for (const row of rows) {
    const cost = calculateBackfillCost(row, catalog);
    if (cost === undefined) continue;
    if (apply && !await write(row, cost)) continue;
    const model = (row.payload as { model: string }).model;
    const total = totals[model] ?? { count: 0, cost_usd: 0 };
    total.count += 1;
    total.cost_usd = Math.round((total.cost_usd + cost) * 1_000_000) / 1_000_000;
    totals[model] = total;
  }
  return totals;
}
