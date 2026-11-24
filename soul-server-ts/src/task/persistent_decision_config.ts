import type {
  PersistentDecisionConfig,
  PresetDecisionConfig,
} from "./persistent_decision.js";

const claudeOpus: PresetDecisionConfig = {
  read_mult: 0.05,
  write_mult: 2.0,
  cache_policy: { kind: "fixed_ttl", ttl_seconds: 3_300 },
  checkpoint_default_tokens: 33_000,
};

const codexSol: PresetDecisionConfig = {
  read_mult: 0.05,
  write_mult: 1.25,
  cache_policy: { kind: "fixed_ttl", ttl_seconds: 1_500 },
  checkpoint_default_tokens: 33_000,
};

const antigravity: PresetDecisionConfig = {
  read_mult: 0.05,
  write_mult: 1.0,
  cache_policy: { kind: "implicit", profile_version: "antigravity-first-call-20261114-v1" },
  checkpoint_default_tokens: 33_000,
};

// Each entry is [upper idle bound, cached input, total input, sample count].
export type FirstCallCacheBin = [number, number, number, number];
export function firstCallCacheEstimate(bins: readonly FirstCallCacheBin[] | undefined, idleSeconds: number): {
  fraction: number | null; sampleCount: number; cached: number; input: number;
} {
  const bin = bins?.find(([upper]) => idleSeconds < upper);
  if (!bin) return { fraction: null, sampleCount: 0, cached: 0, input: 0 };
  const [, cached, input, sampleCount] = bin;
  return { fraction: input > 0 ? cached / input : null, sampleCount, cached, input };
}

export const DEFAULT_CONFIG: PersistentDecisionConfig = {
  provider_defaults: {
    claude: claudeOpus,
    codex: codexSol,
    antigravity,
  },
  budget_tokens: 120_000,
  cold_ratio: 1.25,
  keepalive_margin_seconds: 300,
  keepalive_short_floor: 20,
  keepalive_weekly_floor: -40,
  generation_short_floor: 10,
  generation_weekly_floor: 1,
  default_weekly_reserve: 10,
  usage_stale_seconds: 1_200,
  usage_refresh_seconds: 300,
};
