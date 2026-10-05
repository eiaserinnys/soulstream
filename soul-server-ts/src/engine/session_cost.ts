export interface SessionCostBase {
  usd: number;
  partial: boolean;
}

export function stampSessionCost(
  payload: Record<string, unknown>,
  base: SessionCostBase,
): SessionCostBase {
  if (payload.type !== "complete") return base;

  const turnCost = payload.turn_cost_usd;
  if (typeof turnCost !== "number" || !Number.isFinite(turnCost)) return base;

  const next = {
    usd: Math.round((base.usd + turnCost) * 1_000_000) / 1_000_000,
    partial: base.partial,
  };
  payload.session_cost_usd = next.usd;
  if (base.partial) payload.session_cost_partial = true;
  return next;
}
