export type SupervisorHandoverState =
  | "idle"
  | "idle_pending"
  | "hard_pending"
  | "handover_running";

export interface SupervisorHandoverRegistry {
  handoverState: string;
  cumulativeTokens: number;
  updatedAt?: Date;
}

export interface SupervisorRuntimeSnapshot {
  idle: boolean;
  atTurnBoundary: boolean;
}

export interface SupervisorHandoverPolicyOptions {
  softTokenThreshold?: number;
  hardTokenThreshold?: number;
  minIntervalMs?: number;
  now?: Date;
}

export interface SupervisorHandoverDecision {
  state: SupervisorHandoverState;
  changed: boolean;
  reason:
    | "below_threshold"
    | "soft_waiting_for_idle"
    | "soft_idle_ready"
    | "hard_waiting_for_turn_boundary"
    | "hard_turn_boundary_ready"
    | "handover_already_running"
    | "min_interval_guard";
}

export const DEFAULT_SOFT_TOKEN_THRESHOLD = 1_000_000;
export const DEFAULT_HARD_TOKEN_THRESHOLD = 1_500_000;
export const DEFAULT_HANDOVER_MIN_INTERVAL_MS = 10 * 60 * 1000;

export function evaluateSupervisorHandover(
  registry: SupervisorHandoverRegistry,
  runtime: SupervisorRuntimeSnapshot,
  options: SupervisorHandoverPolicyOptions = {},
): SupervisorHandoverDecision {
  const current = normalizeHandoverState(registry.handoverState);
  if (current === "handover_running") {
    return { state: current, changed: false, reason: "handover_already_running" };
  }

  if (isWithinMinInterval(registry, options)) {
    return { state: current, changed: false, reason: "min_interval_guard" };
  }

  const softThreshold = options.softTokenThreshold ?? DEFAULT_SOFT_TOKEN_THRESHOLD;
  const hardThreshold = options.hardTokenThreshold ?? DEFAULT_HARD_TOKEN_THRESHOLD;

  if (registry.cumulativeTokens >= hardThreshold) {
    if (runtime.atTurnBoundary) {
      return {
        state: "handover_running",
        changed: true,
        reason: "hard_turn_boundary_ready",
      };
    }
    return {
      state: "hard_pending",
      changed: current !== "hard_pending",
      reason: "hard_waiting_for_turn_boundary",
    };
  }

  if (registry.cumulativeTokens >= softThreshold || current === "idle_pending") {
    if (runtime.idle) {
      return {
        state: "handover_running",
        changed: true,
        reason: "soft_idle_ready",
      };
    }
    return {
      state: "idle_pending",
      changed: current !== "idle_pending",
      reason: "soft_waiting_for_idle",
    };
  }

  return {
    state: "idle",
    changed: current !== "idle",
    reason: "below_threshold",
  };
}

export function normalizeHandoverState(value: string): SupervisorHandoverState {
  if (
    value === "idle"
    || value === "idle_pending"
    || value === "hard_pending"
    || value === "handover_running"
  ) {
    return value;
  }
  return "idle";
}

function isWithinMinInterval(
  registry: SupervisorHandoverRegistry,
  options: SupervisorHandoverPolicyOptions,
): boolean {
  if (!registry.updatedAt) return false;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_HANDOVER_MIN_INTERVAL_MS;
  if (minIntervalMs <= 0) return false;
  const now = options.now ?? new Date();
  return now.getTime() - registry.updatedAt.getTime() < minIntervalMs;
}
