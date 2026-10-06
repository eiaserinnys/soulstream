import { describe, expect, it } from "vitest";

import {
  decidePersistentGeneration,
  type DecisionInput,
  type DecisionResult,
} from "../../src/task/persistent_decision.js";

const NOW = "2026-10-06T12:00:00.000Z";

interface DecisionCase {
  name: string;
  input: Partial<DecisionInput>;
  expected: Partial<DecisionResult>;
  expectedSnapshot?: Record<string, unknown>;
}

function makeInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  const defaults: DecisionInput = {
    trigger: "arrival",
    now: NOW,
    context_tokens: 100_000,
    context_estimated: false,
    last_call_ended_at: "2026-10-06T11:30:00.000Z",
    keepalive_count: 0,
    current_preset: "claude-opus",
    default_model: "claude-opus",
    fallback_model: "codex-6.1-sol",
    preset_providers: {
      "claude-opus": "claude",
      "codex-6.1-sol": "codex",
      "claude-sonnet": "claude",
    },
    checkpoint_tokens_by_preset: {},
    accounts: {
      claude: {
        weekly_headroom: 0,
        weekly_remaining_percent: 50,
        short_remaining_percent: 60,
        short_reset_at: "2026-10-06T13:00:00.000Z",
        observed_at: NOW,
      },
      codex: {
        weekly_headroom: 0,
        weekly_remaining_percent: 50,
        short_remaining_percent: 60,
        short_reset_at: "2026-10-06T13:00:00.000Z",
        observed_at: NOW,
      },
    },
  };
  return {
    ...defaults,
    ...overrides,
    preset_providers: {
      ...defaults.preset_providers,
      ...overrides.preset_providers,
    },
    checkpoint_tokens_by_preset: {
      ...defaults.checkpoint_tokens_by_preset,
      ...overrides.checkpoint_tokens_by_preset,
    },
    accounts: {
      ...defaults.accounts,
      ...overrides.accounts,
    },
  };
}

const decisionCases: DecisionCase[] = [
  {
    name: "arrival.cold.over_ratio",
    input: {
      trigger: "arrival",
      context_tokens: 42_000,
      last_call_ended_at: "2026-10-06T10:59:59.000Z",
    },
    expected: {
      action: "new_generation",
      rule: "arrival.cold.over_ratio",
      target_preset: "claude-opus",
    },
    expectedSnapshot: { preset_rule: "preset.default" },
  },
  {
    name: "arrival.cold.within_ratio",
    input: {
      trigger: "arrival",
      context_tokens: 41_250,
      last_call_ended_at: "2026-10-06T10:59:59.000Z",
    },
    expected: { action: "continue", rule: "arrival.cold.within_ratio" },
    expectedSnapshot: {
      idle_seconds: 3601,
      checkpoint_tokens: 33_000,
      checkpoint_source: "default",
    },
  },
  {
    name: "arrival.warm.over_budget",
    input: { trigger: "arrival", context_tokens: 120_001 },
    expected: {
      action: "new_generation",
      rule: "arrival.warm.over_budget",
      target_preset: "claude-opus",
    },
    expectedSnapshot: { preset_rule: "preset.default" },
  },
  {
    name: "arrival.warm.within_budget",
    input: { trigger: "arrival", context_tokens: 120_000 },
    expected: { action: "continue", rule: "arrival.warm.within_budget" },
  },
  {
    name: "turn_end.over_budget",
    input: { trigger: "turn_end", context_tokens: 120_001 },
    expected: { action: "let_cool", rule: "turn_end.over_budget" },
  },
  {
    name: "turn_end.short_floor for fresh low usage",
    input: {
      trigger: "turn_end",
      context_tokens: 100_000,
      accounts: { claude: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 19, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: { action: "let_cool", rule: "turn_end.short_floor" },
  },
  {
    name: "turn_end.short_floor for stale observation",
    input: {
      trigger: "turn_end",
      accounts: { claude: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: "2026-10-06T11:39:59.000Z" } },
    },
    expected: { action: "let_cool", rule: "turn_end.short_floor" },
  },
  {
    name: "turn_end.weekly_floor",
    input: {
      trigger: "turn_end",
      accounts: { claude: { weekly_headroom: -41, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: { action: "let_cool", rule: "turn_end.weekly_floor" },
  },
  {
    name: "turn_end.weekly_floor when its value is missing",
    input: {
      trigger: "turn_end",
      accounts: { claude: { weekly_headroom: null, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: { action: "let_cool", rule: "turn_end.weekly_floor" },
  },
  {
    name: "turn_end.no_context",
    input: { trigger: "turn_end", context_tokens: 0 },
    expected: { action: "let_cool", rule: "turn_end.no_context" },
  },
  {
    name: "turn_end.cap_reached",
    input: {
      trigger: "turn_end",
      context_tokens: 100_000,
      keepalive_count: 12,
      checkpoint_tokens_by_preset: { "claude-opus": 33_000 },
    },
    expected: { action: "let_cool", rule: "turn_end.cap_reached" },
    expectedSnapshot: { cap: 12, checkpoint_source: "measured" },
  },
  {
    name: "turn_end.keepalive and wake_at calculation",
    input: {
      trigger: "turn_end",
      context_tokens: 100_000,
      keepalive_count: 11,
      checkpoint_tokens_by_preset: { "claude-opus": 33_000 },
      last_call_ended_at: "2026-10-06T11:00:00.000Z",
    },
    expected: {
      action: "schedule_keepalive",
      rule: "turn_end.keepalive",
      wake_at: "2026-10-06T11:50:00.000Z",
    },
    expectedSnapshot: { cap: 12, checkpoint_source: "measured" },
  },
  {
    name: "limit_hit.switch",
    input: {
      trigger: "limit_hit",
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      accounts: { codex: { weekly_headroom: 0, weekly_remaining_percent: 20, short_remaining_percent: 10, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: {
      action: "new_generation",
      rule: "limit_hit.switch",
      target_preset: "codex-6.1-sol",
    },
    expectedSnapshot: { preset_rule: "preset.single" },
  },
  {
    name: "limit_hit.switch requires a fresh observation",
    input: {
      trigger: "limit_hit",
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      limit_reset_at: "2026-10-06T13:00:00.000Z",
      accounts: { codex: { weekly_headroom: 0, weekly_remaining_percent: 20, short_remaining_percent: 50, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: "2026-10-06T11:39:59.000Z" } },
    },
    expected: { action: "wait_until", rule: "limit_hit.wait", wake_at: "2026-10-06T13:00:00.000Z" },
  },
  {
    name: "limit_hit.switch requires the short-window floor",
    input: {
      trigger: "limit_hit",
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      limit_reset_at: "2026-10-06T13:00:00.000Z",
      accounts: { codex: { weekly_headroom: 0, weekly_remaining_percent: 20, short_remaining_percent: 9, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: { action: "wait_until", rule: "limit_hit.wait", wake_at: "2026-10-06T13:00:00.000Z" },
  },
  {
    name: "limit_hit.switch requires positive weekly remaining",
    input: {
      trigger: "limit_hit",
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      limit_reset_at: "2026-10-06T13:00:00.000Z",
      accounts: { codex: { weekly_headroom: 0, weekly_remaining_percent: 0, short_remaining_percent: 50, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: { action: "wait_until", rule: "limit_hit.wait", wake_at: "2026-10-06T13:00:00.000Z" },
  },
  {
    name: "limit_hit.switch treats a missing weekly value as stale",
    input: {
      trigger: "limit_hit",
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      limit_reset_at: "2026-10-06T13:00:00.000Z",
      accounts: { codex: { weekly_headroom: 0, weekly_remaining_percent: null, short_remaining_percent: 50, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: { action: "wait_until", rule: "limit_hit.wait", wake_at: "2026-10-06T13:00:00.000Z" },
  },
  {
    name: "limit_hit.wait",
    input: {
      trigger: "limit_hit",
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      limit_reset_at: "2026-10-06T13:00:00.000Z",
      accounts: { codex: { weekly_headroom: 0, short_remaining_percent: 9, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW } },
    },
    expected: {
      action: "wait_until",
      rule: "limit_hit.wait",
      wake_at: "2026-10-06T13:00:00.000Z",
    },
  },
  {
    name: "preset.short_floor_all",
    input: {
      trigger: "arrival",
      context_tokens: 120_001,
      accounts: {
        claude: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 9, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW },
        codex: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 9, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW },
      },
    },
    expected: { action: "new_generation", rule: "arrival.warm.over_budget", target_preset: "claude-opus" },
    expectedSnapshot: { preset_rule: "preset.short_floor_all" },
  },
  {
    name: "preset.stale_keep_current",
    input: {
      trigger: "arrival",
      current_preset: "claude-sonnet",
      context_tokens: 120_001,
      accounts: { codex: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: "2026-10-06T11:39:59.000Z" } },
    },
    expected: { action: "new_generation", rule: "arrival.warm.over_budget", target_preset: "claude-sonnet" },
    expectedSnapshot: { preset_rule: "preset.stale_keep_current" },
  },
  {
    name: "preset.single",
    input: {
      trigger: "arrival",
      context_tokens: 120_001,
      fallback_model: "claude-opus",
    },
    expected: { action: "new_generation", rule: "arrival.warm.over_budget", target_preset: "claude-opus" },
    expectedSnapshot: { preset_rule: "preset.single" },
  },
  {
    name: "preset.fallback_by_gap",
    input: {
      trigger: "arrival",
      current_preset: "claude-sonnet",
      context_tokens: 120_001,
      accounts: {
        claude: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW },
        codex: { weekly_headroom: 25, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW },
      },
    },
    expected: { action: "new_generation", rule: "arrival.warm.over_budget", target_preset: "codex-6.1-sol" },
    expectedSnapshot: { preset_rule: "preset.fallback_by_gap" },
  },
  {
    name: "preset.default",
    input: {
      trigger: "arrival",
      current_preset: "claude-sonnet",
      context_tokens: 120_001,
      accounts: {
        claude: { weekly_headroom: 0, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW },
        codex: { weekly_headroom: 24, weekly_remaining_percent: 50, short_remaining_percent: 60, short_reset_at: "2026-10-06T13:00:00.000Z", observed_at: NOW },
      },
    },
    expected: { action: "new_generation", rule: "arrival.warm.over_budget", target_preset: "claude-opus" },
    expectedSnapshot: { preset_rule: "preset.default" },
  },
  {
    name: "checkpoint falls back to the current preset default",
    input: {
      trigger: "arrival",
      current_preset: "claude-sonnet",
      context_tokens: 40_000,
      last_call_ended_at: "2026-10-06T10:59:59.000Z",
    },
    expected: { action: "continue", rule: "arrival.cold.within_ratio" },
    expectedSnapshot: { checkpoint_tokens: 33_000, checkpoint_source: "default" },
  },
  {
    name: "an unconfigured preset uses its provider defaults",
    input: {
      trigger: "arrival",
      current_preset: "claude-sonnet",
      context_tokens: 50_000,
      last_call_ended_at: "2026-10-06T11:26:40.000Z",
    },
    expected: { action: "continue", rule: "arrival.warm.within_budget" },
    expectedSnapshot: { cache_ttl_seconds: 3_300, checkpoint_tokens: 33_000 },
  },
];

describe("decidePersistentGeneration", () => {
  it.each(decisionCases)("$name", ({ input, expected, expectedSnapshot }) => {
    const result = decidePersistentGeneration(makeInput(input));

    expect(result).toMatchObject(expected);
    if (expectedSnapshot) {
      expect(result.inputs_snapshot).toMatchObject(expectedSnapshot);
    }
    expect(result.inputs_snapshot).toMatchObject(input);
    expect(result.reason).toMatch(/^.+[。.]$/u);
  });
});
