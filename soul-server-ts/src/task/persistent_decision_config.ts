import type {
  PersistentDecisionConfig,
  PresetDecisionConfig,
} from "./persistent_decision.js";

const claudeOpus: PresetDecisionConfig = {
  read_mult: 0.05,
  write_mult: 2.0,
  cache_ttl_seconds: 3_300,
  checkpoint_default_tokens: 33_000,
};

const codexSol: PresetDecisionConfig = {
  read_mult: 0.05,
  write_mult: 1.25,
  cache_ttl_seconds: 1_500,
  checkpoint_default_tokens: 33_000,
};

export const DEFAULT_CONFIG: PersistentDecisionConfig = {
  presets: {
    "claude-opus": claudeOpus,
    "codex-6.1-sol": codexSol,
  },
  provider_defaults: {
    claude: claudeOpus,
    codex: codexSol,
  },
  budget_tokens: 120_000,
  cold_ratio: 1.25,
  keepalive_margin_seconds: 300,
  keepalive_short_floor: 20,
  keepalive_weekly_floor: -40,
  generation_short_floor: 10,
  headroom_gap: 25,
  usage_stale_seconds: 1_200,
  usage_refresh_seconds: 300,
};
