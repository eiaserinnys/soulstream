export const representativeProviderEvents = {
  claude: {
    sessionId: "fixture-claude",
    eventId: 1,
    eventType: "complete",
    createdAt: "2026-10-19T00:00:00.000Z",
    payload: {
      type: "complete",
      model: "claude-opus-5-5",
      output_command_id: "claude-command",
      usage_snapshot: {
        schema_version: 1,
        backend: "claude",
        provider: "claude",
        preset_id: null,
        requested_model: "claude-opus-5-5",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 245_563,
        cache_creation_input_tokens: 1_141,
        output_tokens: 272,
      },
      first_call: { input_tokens: 246_708, cached_input_tokens: 245_563 },
      total_cost_usd: 0,
    },
  },
  codex: {
    sessionId: "fixture-codex",
    eventId: 2,
    eventType: "complete",
    createdAt: "2026-10-19T00:00:01.000Z",
    payload: {
      type: "complete",
      model: "gpt-6-luna",
      output_command_id: "codex-command",
      usage_snapshot: {
        schema_version: 1,
        backend: "codex",
        provider: "codex",
        preset_id: null,
        requested_model: "gpt-6-luna",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 100,
        cached_input_tokens: 25,
        output_tokens: 30,
        reasoning_output_tokens: 7,
      },
    },
  },
  antigravity: {
    sessionId: "fixture-antigravity",
    eventId: 3,
    eventType: "complete",
    createdAt: "2026-10-19T00:00:02.000Z",
    payload: {
      type: "complete",
      model: "gemini-4-argon",
      output_command_id: "antigravity-command",
      usage_snapshot: {
        schema_version: 1,
        backend: "antigravity",
        provider: "antigravity",
        preset_id: null,
        requested_model: "gemini-4-argon",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 195,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  },
  opencodeToolResume: {
    sessionId: "fixture-opencode",
    eventId: 4,
    eventType: "usage_observation",
    createdAt: "2026-10-19T00:00:03.000Z",
    payload: {
      type: "usage_observation",
      output_command_id: "opencode-resume-command",
      input_id: "input-opencode-resume",
      accounting_key: "opencode-resume-command",
      outcome: "interrupted",
      source: "opencode_step_finish",
      model: "opencode/deepseek-v4.1-flash-free",
      usage_snapshot: {
        schema_version: 1,
        backend: "opencode",
        provider: "deepseek",
        preset_id: null,
        requested_model: "opencode/deepseek-v4.1-flash-free",
        provider_attribution: "configured_alias",
      },
      usage_scope: "command_delta",
      usage: {
        input_tokens: 6_644,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 78,
        reasoning_output_tokens: 6,
      },
      raw_usage: {
        input: 6_644,
        output: 72,
        reasoning: 6,
        cache_read: 0,
        cache_write: 0,
        total: 6_722,
      },
    },
  },
  opencodePlain: {
    sessionId: "fixture-opencode",
    eventId: 5,
    eventType: "complete",
    createdAt: "2026-10-19T00:00:04.000Z",
    payload: {
      type: "complete",
      output_command_id: "opencode-plain-command",
      model: "opencode/deepseek-v4.1-flash-free",
      usage_snapshot: {
        schema_version: 1,
        backend: "opencode",
        provider: "deepseek",
        preset_id: null,
        requested_model: "opencode/deepseek-v4.1-flash-free",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 3_208,
        cached_input_tokens: 1_792,
        cache_write_input_tokens: 0,
        output_tokens: 6,
        reasoning_output_tokens: 0,
      },
    },
  },
  kimi: {
    sessionId: "fixture-kimi",
    eventId: 6,
    eventType: "complete",
    createdAt: "2026-10-19T00:00:05.000Z",
    payload: {
      type: "complete",
      model: "kimi-for-coding",
      output_command_id: "kimi-command",
      usage_snapshot: {
        schema_version: 1,
        backend: "claude",
        provider: "kimi",
        preset_id: null,
        requested_model: "kimi-for-coding",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 11,
        output_tokens: 13,
      },
    },
  },
} as const;

const noWriteCacheVectors: Array<{
  name: string;
  provider: string;
  model: string;
  usage: Record<string, unknown>;
  expected: Record<string, unknown>;
}> = [
  {
    name: "codex parent cache without write", provider: "codex", model: "gpt-6-luna",
    usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 30 },
    expected: { cache_write: 0, input_total: 100, cache_read: 25, pricing_complete: true, priced_tokens: 130, unpriced_tokens: 0, known_cost_usd: 0.00002275 },
  },
  {
    name: "codex provider without cache fields", provider: "codex", model: "gpt-6-luna",
    usage: { input_tokens: 100, output_tokens: 30 },
    expected: { cache_write: 0, cache_read: null, pricing_complete: false },
  },
  {
    name: "antigravity provider without parent cache marker", provider: "antigravity", model: "gemini-4-argon",
    usage: { input_total: 100, cache_read_input_tokens: 25, output_tokens: 30 },
    expected: { cache_write: 0, input_total: 100, pricing_complete: true, priced_tokens: 130, unpriced_tokens: 0 },
  },
  {
    name: "deepseek provider without parent cache marker", provider: "deepseek", model: "deepseek-flash",
    usage: { input_total: 100, cache_read_input_tokens: 25, output_tokens: 30 },
    expected: { cache_write: 0, input_total: 100, pricing_complete: true, priced_tokens: 130, unpriced_tokens: 0 },
  },
  {
    name: "claude missing native write", provider: "claude", model: "claude-opus-5-5",
    usage: { input_tokens: 100, cache_read_input_tokens: 25, output_tokens: 30 },
    expected: { cache_write: null, pricing_complete: false },
  },
  {
    name: "kimi missing native write", provider: "kimi", model: "kimi-for-coding",
    usage: { input_tokens: 100, cache_read_input_tokens: 25, output_tokens: 30 },
    expected: { cache_write: null, pricing_complete: false },
  },
  {
    name: "unknown without a format marker", provider: "unknown", model: "unlisted-model",
    usage: { input_tokens: 100, output_tokens: 30 },
    expected: { cache_write: null, pricing_complete: false },
  },
  {
    name: "unknown with parent cache marker", provider: "unknown", model: "unlisted-model",
    usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 30 },
    expected: { cache_write: 0, input_total: 100, cache_read: 25, pricing_complete: false },
  },
  {
    name: "explicit write amount", provider: "codex", model: "gpt-6-luna",
    usage: { input_tokens: 100, cached_input_tokens: 25, cache_write_input_tokens: 5, output_tokens: 30 },
    expected: { cache_write: 5, pricing_complete: false },
  },
  {
    name: "explicit unknown native creation", provider: "codex", model: "gpt-6-luna",
    usage: { input_tokens: 100, cached_input_tokens: 25, cacheCreationInputTokens: null, output_tokens: 30 },
    expected: { cache_write: null, pricing_complete: false, quality: ["normalization_error"] },
  },
];

export const noWriteCacheCases = noWriteCacheVectors.map(({ name, provider, model, usage, expected }) => ({
  name,
  expected,
  event: {
    ...representativeProviderEvents.codex,
    payload: {
      ...representativeProviderEvents.codex.payload,
      model,
      usage_snapshot: {
        ...representativeProviderEvents.codex.payload.usage_snapshot,
        backend: provider === "deepseek" ? "opencode" : provider === "kimi" ? "claude" : provider,
        provider,
        requested_model: model,
      },
      usage,
    },
  },
}));

const modelBreakdown = {
  "claude-opus-5-5": {
    inputTokens: 4,
    outputTokens: 10,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 5,
    costUSD: 0,
  },
  "claude/sonnet%5Bcanonical]": {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
  },
} as const;

export const claudeModelBreakdownEvents = [
  {
    sessionId: "fixture-model-map",
    eventId: 10,
    eventType: "complete",
    createdAt: "2026-10-19T00:01:00.000Z",
    payload: {
      type: "complete",
      model: "claude-opus-5-5",
      output_command_id: "model-map-command",
      usage_snapshot: {
        schema_version: 1,
        backend: "claude",
        provider: "claude",
        preset_id: null,
        requested_model: "claude-opus-5-5",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 10,
      },
      model_usage: modelBreakdown,
    },
  },
  {
    sessionId: "fixture-model-map",
    eventId: 11,
    eventType: "complete",
    createdAt: "2026-10-19T00:01:00.000Z",
    payload: {
      type: "complete",
      model: "claude-opus-5-5",
      output_command_id: "model-map-command",
      usage_snapshot: {
        schema_version: 1,
        backend: "claude",
        provider: "claude",
        preset_id: null,
        requested_model: "claude-opus-5-5",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 10,
      },
      model_usage: Object.fromEntries(Object.entries(modelBreakdown).reverse()),
    },
  },
] as const;

export const unverifiedClaudeModelBreakdownEvent = {
  sessionId: "fixture-unverified-model-map",
  eventId: 12,
  eventType: "complete",
  createdAt: "2026-10-19T00:01:01.000Z",
  payload: {
    type: "complete",
    model: "claude-opus-5-5",
    output_command_id: "unverified-model-map-command",
    usage_snapshot: {
      schema_version: 1,
      backend: "claude",
      provider: "claude",
      preset_id: null,
      requested_model: "claude-opus-5-5",
      provider_attribution: "configured_alias",
    },
    usage: {
      input_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      output_tokens: 10,
    },
    model_usage: {
      "claude-opus-5-5": {
        inputTokens: 3,
        outputTokens: 10,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
      },
    },
  },
} as const;

export const keylessSystemMaterialEvents = [
  {
    sessionId: "fixture-keyless-system-material",
    eventId: 101,
    eventType: "system_message",
    createdAt: "2026-10-19T00:09:00.000Z",
    payload: { type: "system_message", text: "safe system prompt" },
  },
  {
    sessionId: "fixture-keyless-system-material",
    eventId: 102,
    eventType: "input_material_manifest",
    createdAt: "2026-10-19T00:09:01.000Z",
    payload: {
      type: "input_material_manifest",
      output_command_id: "system-material-command",
      execution_input: {
        command_id: "system-material-command",
        parts: [{ category: "system_prompt", source_key: "system/prompt", raw_chars_utf16: 18, approximate_tokens: 5, estimate_source: "manifest" }],
      },
    },
  },
] as const;

export const expectedCanonicalInputMaterialFacts = [
  { eventId: 102, partKey: "material/0", sourceKey: "system/prompt", category: "system_prompt", approximateTokens: 5 },
] as const;

export const canonicalOwnershipEvents = [
  { sessionId: "owners", eventId: 10, eventType: "result", createdAt: "2026-10-19T00:02:00Z", payload: { type: "result", success: true, output_command_id: "complete-wins", usage: { input_tokens: 99, output_tokens: 9 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 11, eventType: "complete", createdAt: "2026-10-19T00:02:01Z", payload: { type: "complete", output_command_id: "complete-wins", usage: { input_tokens: 10, output_tokens: 1 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 20, eventType: "result", createdAt: "2026-10-19T00:02:02Z", payload: { type: "result", success: false, output_command_id: "error-wins", usage: { input_tokens: 90, output_tokens: 9 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 21, eventType: "error", createdAt: "2026-10-19T00:02:03Z", payload: { type: "error", fatal: true, output_command_id: "error-wins", usage: { input_tokens: 15, output_tokens: 2 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 22, eventType: "error", createdAt: "2026-10-19T00:02:03Z", payload: { type: "error", fatal: true, output_command_id: "error-wins", usage: { input_tokens: 1, output_tokens: 1 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 30, eventType: "usage_observation", createdAt: "2026-10-19T00:02:04Z", payload: { type: "usage_observation", outcome: "interrupted", source: "opencode_step_finish", output_command_id: "terminal-wins", accounting_key: "terminal-wins", usage: { input_tokens: 12, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 }, usage_snapshot: { schema_version: 1, backend: "opencode", provider: "deepseek", preset_id: null, requested_model: "deepseek-flash", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 31, eventType: "complete", createdAt: "2026-10-19T00:02:05Z", payload: { type: "complete", output_command_id: "terminal-wins", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 40, eventType: "error", createdAt: "2026-10-19T00:02:06Z", payload: { type: "error", fatal: true, output_command_id: "missing-complete-wins", usage: { input_tokens: 8, output_tokens: 1 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 41, eventType: "complete", createdAt: "2026-10-19T00:02:07Z", payload: { type: "complete", output_command_id: "missing-complete-wins", usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 50, eventType: "complete", createdAt: "2026-10-19T00:02:08Z", payload: { type: "complete", output_command_id: "same-token-a", input_id: "same-input", usage: { input_tokens: 10, output_tokens: 2 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 51, eventType: "complete", createdAt: "2026-10-19T00:02:09Z", payload: { type: "complete", output_command_id: "same-token-b", input_id: "same-input", usage: { input_tokens: 10, output_tokens: 2 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
  { sessionId: "owners", eventId: 60, eventType: "result", createdAt: "2026-10-19T00:02:10Z", payload: { type: "result", success: true, output_command_id: "pending-result", usage: { input_tokens: 500, output_tokens: 50 }, usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" } } },
] as const;

export const expectedCanonicalOwners = {
  "complete-wins": 11,
  "error-wins": 22,
  "terminal-wins": 31,
  "missing-complete-wins": 41,
  "same-token-a": 50,
  "same-token-b": 51,
  "pending-result": null,
} as const;
