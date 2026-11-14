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

// First-call observations, 2026-11-09 through 2026-11-14 06:50 UTC.
// Entries are [upper idle bound, cached input, total input, sample count].
const cacheBins = {
  "gemini-4-hydrogen": [
    [60, 590944, 607686, 5], [180, 575717, 588572, 4], [240, 341836, 441173, 4],
    [300, 0, 0, 0], [600, 0, 0, 0], [900, 0, 0, 0], [1800, 101127, 523094, 3],
    [3300, 0, 91181, 1], [3600, 0, 0, 0], [Infinity, 0, 0, 0],
  ],
  "gemini-4-argon": [
    [60, 3836757, 4772657, 29], [180, 3156926, 4616740, 26], [240, 1291316, 1520147, 9],
    [300, 68117, 1984754, 11], [600, 1018136, 5053005, 29], [900, 702269, 3722782, 23],
    [1800, 445443, 3167534, 17], [3300, 0, 961983, 5], [3600, 0, 244153, 1],
    [Infinity, 228340, 1276231, 8],
  ],
} satisfies Record<string, [number, number, number, number][]>;

export function firstCallCacheEstimate(preset: string, idleSeconds: number): {
  fraction: number | null; sampleCount: number; cached: number; input: number;
} {
  const bins = cacheBins[preset as keyof typeof cacheBins];
  const bin = bins?.find(([upper]) => idleSeconds < upper);
  if (!bin) return { fraction: null, sampleCount: 0, cached: 0, input: 0 };
  const [, cached, input, sampleCount] = bin;
  return { fraction: input > 0 ? cached / input : null, sampleCount, cached, input };
}

// The Argon raw usage is the average of the two middle cost samples of 102
// initial-manifest turns; it is a cross-workload fallback, not a PAS measurement.
export const GENERATION_COST_SEEDS = {
  "gemini-4-hydrogen": {
    baselineTokens: 130418, growthTokensPerCall: 9446 / 3,
    input: 695025, cached: 565185, output: 8441, reasoning: 6693,
    source: "hydrogen-pas-generation-296", sampleCount: 1,
  },
  "gemini-4-argon": {
    baselineTokens: 120305.5, growthTokensPerCall: 24309 / 8,
    input: (1630116 + 1402165) / 2, cached: (1461045 + 1225596) / 2,
    output: (6224 + 11675) / 2, reasoning: (4054 + 6082) / 2,
    source: "argon-cross-workload-median", sampleCount: 102,
  },
} as const;

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
