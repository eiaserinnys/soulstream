import { describe, expect, it } from "vitest";

import {
  CANONICAL_USAGE_PRIORITY,
  normalizeSessionStatisticsEvent,
  selectCanonicalInputMaterialFacts,
  selectCanonicalUsageCandidates,
} from "../src/usage/session_statistics_normalizer.js";
import {
  canonicalOwnershipEvents,
  claudeModelBreakdownEvents,
  claudeCacheTtlCases,
  expectedCanonicalInputMaterialFacts,
  expectedCanonicalOwners,
  keylessSystemMaterialEvents,
  noWriteCacheCases,
  representativeProviderEvents,
  unverifiedClaudeModelBreakdownEvent,
} from "./fixtures/session_statistics_normalizer.fixtures.js";

function normalize(event: Parameters<typeof normalizeSessionStatisticsEvent>[0]) {
  return normalizeSessionStatisticsEvent(event);
}

function usageFact(event: Parameters<typeof normalizeSessionStatisticsEvent>[0]) {
  return normalize(event).facts.find((fact) => fact.fact_kind === "usage" && fact.representation !== "diagnostic");
}

function unknownClaudeEvent(
  eventId: number,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    sessionId: "native-format",
    eventId,
    eventType: "complete",
    createdAt: "2026-10-20T00:10:00Z",
    payload: {
      type: "complete",
      model: "claude-opus-5-5",
      output_command_id: `native-format-${eventId}`,
      usage_snapshot: {
        schema_version: 1,
        backend: "claude",
        provider: "unknown",
        preset_id: null,
        requested_model: "claude-opus-5-5",
        provider_attribution: "unknown",
      },
      usage,
      ...extra,
    },
  };
}

describe("session statistics native usage number format", () => {
  it.each(claudeCacheTtlCases)("prices Claude cache TTL: $name", ({ event, expected }) => {
    expect(normalize(event).facts).toEqual(expected.map((fact) => expect.objectContaining(fact)));
  });

  it.each(noWriteCacheCases)("preserves cache write semantics: $name", ({ event, expected }) => {
    expect(usageFact(event)).toMatchObject(expected);
  });

  it("repairs native base/read/write input when snapshot provider is unknown", () => {
    const fact = usageFact(unknownClaudeEvent(200, {
      input_tokens: 12,
      cache_read_input_tokens: 469_276,
      cache_creation_input_tokens: 41_375,
      output_tokens: 1_746,
    }));
    expect(fact).toMatchObject({
      provider: "unknown",
      input_total: 510_663,
      output_total: 1_746,
      total_tokens: 512_409,
      cache_read: 469_276,
      cache_write: 41_375,
      known_cost_usd: null,
    });
    expect((fact?.total_tokens ?? 0) - (fact?.cache_read ?? 0)).toBe(43_133);
    expect((fact?.input_total ?? 0) - (fact?.cache_read ?? 0) - (fact?.cache_write ?? 0)).toBe(12);
  });

  it("normalizes the other observed native vectors", () => {
    const second = usageFact(unknownClaudeEvent(201, {
      input_tokens: 4,
      cache_read_input_tokens: 60_970,
      cache_creation_input_tokens: 61_117,
      output_tokens: 753,
    }));
    expect(second).toMatchObject({
      input_total: 122_091,
      total_tokens: 122_844,
      cache_read: 60_970,
      cache_write: 61_117,
    });
    expect((second?.total_tokens ?? 0) - (second?.cache_read ?? 0)).toBe(61_874);
    expect((second?.input_total ?? 0) - (second?.cache_read ?? 0) - (second?.cache_write ?? 0)).toBe(4);

    const third = usageFact(unknownClaudeEvent(202, {
      input_tokens: 12,
      cache_read_input_tokens: 4_881_539,
      cache_creation_input_tokens: 21_506,
      output_tokens: 12_001,
    }));
    expect(third).toMatchObject({
      input_total: 4_903_057,
      total_tokens: 4_915_058,
      cache_read: 4_881_539,
      cache_write: 21_506,
    });
    expect((third?.total_tokens ?? 0) - (third?.cache_read ?? 0)).toBe(33_519);
    expect((third?.input_total ?? 0) - (third?.cache_read ?? 0) - (third?.cache_write ?? 0)).toBe(12);
  });

  it("accepts camelCase native aliases", () => {
    const fact = usageFact(unknownClaudeEvent(203, {
      inputTokens: 4,
      cacheReadInputTokens: 60_970,
      cacheCreationInputTokens: 61_117,
      outputTokens: 753,
    }));
    expect(fact).toMatchObject({
      input_total: 122_091,
      total_tokens: 122_844,
      cache_read: 60_970,
      cache_write: 61_117,
      quality: expect.not.arrayContaining(["normalization_error"]),
    });
  });

  it("keeps a parent input total when only parent cache aliases are present", () => {
    const fact = usageFact(unknownClaudeEvent(204, {
      input_tokens: 6,
      cached_input_tokens: 3,
      output_tokens: 2,
    }));
    expect(fact).toMatchObject({
      input_total: 6,
      total_tokens: 8,
      cache_read: 3,
      cache_write: 0,
    });
    expect((fact?.total_tokens ?? 0) - (fact?.cache_read ?? 0)).toBe(5);
  });

  it("keeps an explicit parent input total ahead of native fields", () => {
    const fact = usageFact(unknownClaudeEvent(205, {
      input_total: 100,
      input_tokens: 2,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
      output_tokens: 20,
    }));
    expect(fact).toMatchObject({
      input_total: 100,
      total_tokens: 120,
      cache_read: 60,
      cache_write: 10,
    });
    expect((fact?.total_tokens ?? 0) - (fact?.cache_read ?? 0)).toBe(60);
    expect((fact?.input_total ?? 0) - (fact?.cache_read ?? 0) - (fact?.cache_write ?? 0)).toBe(30);
  });

  it("does not fall back to native fields when input_total is explicitly null", () => {
    const fact = usageFact(unknownClaudeEvent(206, {
      input_total: null,
      input_tokens: 2,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
      output_tokens: 20,
    }));
    expect(fact).toMatchObject({
      input_total: null,
      total_tokens: null,
      cache_read: 60,
      cache_write: 10,
      output_total: 20,
    });
    expect(fact?.quality).toContain("normalization_error");
  });

  it("treats measured zeros as known native values", () => {
    const fact = usageFact(unknownClaudeEvent(207, {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    }));
    expect(fact).toMatchObject({
      input_total: 0,
      total_tokens: 0,
      cache_read: 0,
      cache_write: 0,
      quality: expect.not.arrayContaining(["normalization_error"]),
    });
  });

  it("rejects conflicting cache read aliases without dropping the parent", () => {
    const fact = usageFact(unknownClaudeEvent(208, {
      input_tokens: 20,
      cached_input_tokens: 10,
      cache_read_input_tokens: 11,
      output_tokens: 5,
    }));
    expect(fact).toMatchObject({
      input_total: 20,
      total_tokens: 25,
      cache_read: null,
    });
    expect(fact?.quality).toContain("normalization_error");
  });

  it("does not compose a native input when only the legacy read alias is recorded", () => {
    const fact = usageFact(unknownClaudeEvent(209, {
      input_tokens: 50,
      cache_read_input_tokens: 10,
      output_tokens: 5,
    }));
    expect(fact).toMatchObject({
      input_total: null,
      total_tokens: null,
      cache_read: 10,
      cache_write: null,
      output_total: 5,
    });
  });

  it("nulls an impossible parent input while preserving cache components", () => {
    const fact = usageFact(unknownClaudeEvent(210, {
      input_tokens: 10,
      cached_input_tokens: 11,
      output_tokens: 2,
    }));
    expect(fact).toMatchObject({
      input_total: null,
      total_tokens: null,
      cache_read: 11,
      output_total: 2,
    });
    expect(fact?.quality).toContain("normalization_error");
  });

  it("applies the same native numbers to aggregate and model usage parts", () => {
    const facts = normalize(unknownClaudeEvent(211, {
      input_tokens: 12,
      cache_read_input_tokens: 469_276,
      cache_creation_input_tokens: 41_375,
      output_tokens: 1_746,
    }, {
      model_usage: {
        "claude-opus-5-5": {
          inputTokens: 4,
          cacheReadInputTokens: 60_970,
          cacheCreationInputTokens: 61_117,
          outputTokens: 753,
        },
      },
    })).facts.filter((fact) => fact.fact_kind === "usage");
    const aggregate = facts.find((fact) => fact.representation === "aggregate");
    const model = facts.find((fact) => fact.representation === "model_breakdown");
    expect(aggregate).toMatchObject({
      input_total: 510_663,
      total_tokens: 512_409,
      cache_read: 469_276,
      cache_write: 41_375,
    });
    expect(model).toMatchObject({
      model: "claude-opus-5-5",
      input_total: 122_091,
      total_tokens: 122_844,
      cache_read: 60_970,
      cache_write: 61_117,
    });
  });
});

describe("session statistics normalizer", () => {
  it("keeps the provider-specific token subsets and representative OpenCode totals", () => {
    const claude = usageFact(representativeProviderEvents.claude);
    expect(claude).toMatchObject({ provider: "claude", input_total: 246_708, output_total: 272, total_tokens: 246_980, cache_read: 245_563, cache_write: 1_141, reasoning_output: null });

    const codex = usageFact(representativeProviderEvents.codex);
    expect(codex).toMatchObject({ provider: "codex", input_total: 100, output_total: 30, total_tokens: 130, cache_read: 25, reasoning_output: 7 });

    const antigravity = usageFact(representativeProviderEvents.antigravity);
    expect(antigravity).toMatchObject({ provider: "antigravity", input_total: 195, output_total: 0, total_tokens: 195, cache_read: 0, reasoning_output: 0 });

    const resumed = usageFact(representativeProviderEvents.opencodeToolResume);
    expect(resumed).toMatchObject({ provider: "deepseek", input_total: 6_644, output_total: 78, total_tokens: 6_722, reasoning_output: 6 });

    const plain = usageFact(representativeProviderEvents.opencodePlain);
    expect(plain).toMatchObject({ provider: "deepseek", input_total: 3_208, output_total: 6, total_tokens: 3_214 });

    const kimi = usageFact(representativeProviderEvents.kimi);
    expect(kimi).toMatchObject({ provider: "kimi", backend: "claude", model: "kimi-for-coding", input_total: 23, output_total: 13, total_tokens: 36, known_cost_usd: null });
  });

  it("keeps Claude model-map identity stable across enumeration order and encodes each raw key once", () => {
    const [forward, reverse] = claudeModelBreakdownEvents.map((event) =>
      normalize(event).facts.filter((fact) => fact.representation === "model_breakdown")
        .map((fact) => ({ part_key: fact.part_key, model: fact.model, input: fact.input_total, output: fact.output_total, total: fact.total_tokens }))
        .sort((left, right) => left.part_key.localeCompare(right.part_key)));

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([
      { part_key: "usage:model/claude-opus-5-5", model: "claude-opus-5-5", input: 29, output: 10, total: 39 },
      { part_key: "usage:model/claude%2Fsonnet%255Bcanonical%5D", model: "claude/sonnet%5Bcanonical]", input: 0, output: 0, total: 0 },
    ].sort((left, right) => left.part_key.localeCompare(right.part_key)));

    const selected = selectCanonicalUsageCandidates(claudeModelBreakdownEvents.flatMap((event) => normalize(event).facts));
    const owner = selected.find((selection) => selection.accountingKey === "model-map-command");
    expect(owner?.representation).toBe("model_breakdown");
    expect(owner?.facts.map((fact) => fact.part_key)).toHaveLength(2);

    const unverifiedCandidates = normalize(unverifiedClaudeModelBreakdownEvent).facts;
    const unverified = selectCanonicalUsageCandidates(unverifiedCandidates)[0];
    expect(unverifiedCandidates.find((fact) => fact.representation === "aggregate")?.model).toBe("claude-opus-5-5");
    expect(unverified).toMatchObject({
      representation: "aggregate",
      quality: ["model_breakdown_unverified"],
      facts: [expect.objectContaining({
        model: null,
        input_total: 29,
        output_total: 10,
        total_tokens: 39,
        known_cost_usd: null,
        priced_tokens: 0,
        unpriced_tokens: 39,
        pricing_complete: false,
        quality: expect.arrayContaining(["model_breakdown_unverified"]),
      })],
    });
  });

  it("selects one event per command independent of input order and keeps equal-token commands separate", () => {
    const facts = canonicalOwnershipEvents.flatMap((event) => normalize(event).facts);
    const forward = selectCanonicalUsageCandidates(facts);
    const reverse = selectCanonicalUsageCandidates([...facts].reverse());
    const owners = (selections: typeof forward) => Object.fromEntries(selections.map((selection) => [selection.accountingKey, selection.ownerEventId]));

    expect(owners(forward)).toEqual(expectedCanonicalOwners);
    expect(owners(reverse)).toEqual(expectedCanonicalOwners);
    expect(CANONICAL_USAGE_PRIORITY).toEqual({ complete: 4, failed_error: 3, failed_result: 2, interrupt_observation: 1 });

    const sameTokenSelections = forward.filter((selection) => selection.accountingKey?.startsWith("same-token-"));
    expect(sameTokenSelections).toHaveLength(2);
    expect(sameTokenSelections.reduce((sum, selection) => sum + (selection.facts[0]?.total_tokens ?? 0), 0)).toBe(24);

    const missingComplete = forward.find((selection) => selection.accountingKey === "missing-complete-wins");
    expect(missingComplete?.ownerEventId).toBe(41);
    expect(missingComplete?.facts[0]?.total_tokens).toBeNull();
  });

  it("prices only known fixed-price components and does not treat SDK zero cost as free API usage", () => {
    const claude = usageFact(representativeProviderEvents.claude);
    expect(claude?.known_cost_usd).toBeGreaterThan(0);
    expect(claude?.pricing_complete).toBe(false);
    expect(claude?.unpriced_tokens).toBe(1_141);

    const unknown = normalize({
      sessionId: "unknown-model",
      eventId: 70,
      eventType: "complete",
      createdAt: "2026-10-19T00:03:00Z",
      payload: { type: "complete", output_command_id: "unknown-model-command", model: "unlisted-model", usage_snapshot: { schema_version: 1, backend: "claude", provider: "claude", preset_id: null, requested_model: "unlisted-model", provider_attribution: "configured_alias" }, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, total_cost_usd: 0 },
    }).facts.find((fact) => fact.fact_kind === "usage");
    expect(unknown).toMatchObject({ known_cost_usd: null, priced_tokens: 0, pricing_complete: false });

    const requestedOnly = normalize({
      sessionId: "requested-only-model",
      eventId: 71,
      eventType: "complete",
      createdAt: "2026-10-19T00:03:01Z",
      payload: {
        type: "complete",
        output_command_id: "requested-only-command",
        usage_snapshot: { schema_version: 1, backend: "claude", provider: "claude", preset_id: null, requested_model: "claude-opus-5-5", provider_attribution: "configured_alias" },
        usage: { input_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 1 },
      },
    }).facts.find((fact) => fact.fact_kind === "usage");
    expect(requestedOnly).toMatchObject({ model: null, known_cost_usd: null, usage_snapshot: { requested_model: "claude-opus-5-5" } });

    const unattributed = normalize({
      sessionId: "unattributed-provider",
      eventId: 72,
      eventType: "complete",
      createdAt: "2026-10-19T00:03:02Z",
      payload: {
        type: "complete",
        output_command_id: "unattributed-command",
        usage_snapshot: { schema_version: 1, backend: "unknown", provider: "unknown", preset_id: null, requested_model: null, provider_attribution: "unknown" },
        usage: { input_tokens: 6, cached_input_tokens: 3, output_tokens: 2 },
      },
    }).facts.find((fact) => fact.fact_kind === "usage");
    expect(unattributed).toMatchObject({ provider: "unknown", model: null, input_total: 6, output_total: 2, total_tokens: 8, cache_read: 3, known_cost_usd: null });
  });

  it("preserves explicit zero and nulls malformed usage without throwing or copying source text", () => {
    const zero = usageFact({
      sessionId: "zero",
      eventId: 80,
      eventType: "complete",
      createdAt: "2026-10-19T00:04:00Z",
      payload: { type: "complete", output_command_id: "zero-command", model: "gpt-6-luna", usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" }, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
    });
    expect(zero).toMatchObject({ input_total: 0, output_total: 0, total_tokens: 0, cache_read: 0, reasoning_output: 0 });

    const malformed = normalize({ sessionId: "malformed", eventId: 81, eventType: "complete", createdAt: "2026-10-19T00:04:01Z", payload: { type: "complete", output_command_id: "malformed-command", usage: "private error text" } });
    expect(malformed.facts[0]).toMatchObject({ fact_kind: "usage", input_total: null, output_total: null, total_tokens: null, quality: ["normalization_error"] });
    expect(malformed.issues).toContain("normalization_error");
    expect(JSON.stringify(malformed)).not.toContain("private error text");
  });

  it("marks conflicting command identity as excluded from known totals", () => {
    const facts = normalize({
      sessionId: "identity",
      eventId: 90,
      eventType: "usage_observation",
      createdAt: "2026-10-19T00:05:00Z",
      payload: { type: "usage_observation", outcome: "interrupted", source: "opencode_step_finish", output_command_id: "outer-command", accounting_key: "other-command", usage_snapshot: { schema_version: 1, backend: "opencode", provider: "deepseek", preset_id: null, requested_model: "deepseek-flash", provider_attribution: "configured_alias" }, usage: { input_tokens: 12, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    }).facts;
    const selection = selectCanonicalUsageCandidates(facts);
    expect(selection).toHaveLength(1);
    expect(selection[0]).toMatchObject({ state: "identity_conflict", facts: [] });
    expect(facts[0]?.quality).toContain("identity_conflict");
  });

  it("uses the latest manifest for a command, replaces matching body fallback, and leaves hidden material null", () => {
    const events = [
      { sessionId: "material", eventId: 1, eventType: "user_message", createdAt: "2026-10-19T00:06:00Z", payload: { type: "user_message", input_id: "input-a", text: "safe input" } },
      { sessionId: "material", eventId: 2, eventType: "input_material_manifest", createdAt: "2026-10-19T00:06:01Z", payload: { type: "input_material_manifest", output_command_id: "command-a", input_id: "input-a", usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" }, execution_input: { command_id: "command-a", parts: [{ category: "user_prompt", source_key: "input/user", raw_chars_utf16: 8, approximate_tokens: 2, estimate_source: "manifest" }] } } },
      { sessionId: "material", eventId: 3, eventType: "input_material_manifest", createdAt: "2026-10-19T00:06:02Z", payload: { type: "input_material_manifest", output_command_id: "command-a", input_id: "input-a", usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" }, execution_input: { command_id: "command-a", parts: [{ category: "user_prompt", source_key: "input/user", raw_chars_utf16: 8, approximate_tokens: 2, estimate_source: "manifest" }, { category: "user_prompt", source_key: "input/user", raw_chars_utf16: 8, approximate_tokens: 2, estimate_source: "manifest" }] } } },
      { sessionId: "material", eventId: 4, eventType: "user_message", createdAt: "2026-10-19T00:06:03Z", payload: { type: "user_message", input_id: "input-hidden", text: "safe hidden" } },
      { sessionId: "material", eventId: 5, eventType: "input_material_manifest", createdAt: "2026-10-19T00:06:04Z", payload: { type: "input_material_manifest", output_command_id: "command-hidden", input_id: "input-hidden", usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" }, execution_input: { command_id: "command-hidden", parts: null } } },
      { sessionId: "material", eventId: 6, eventType: "context_manifest", createdAt: "2026-10-19T00:06:05Z", payload: { type: "context_manifest", sources: [{ id: "source-a", instance: "atom", chars: 5, token_estimate: 2 }] } },
      { sessionId: "material", eventId: 7, eventType: "input_material_manifest", createdAt: "2026-10-19T00:06:06Z", payload: { type: "input_material_manifest", output_command_id: "command-empty", input_id: "input-empty", usage_snapshot: { schema_version: 1, backend: "codex", provider: "codex", preset_id: null, requested_model: "gpt-6-luna", provider_attribution: "configured_alias" }, execution_input: { command_id: "command-empty", parts: [] } } },
    ];
    const facts = events.flatMap((event) => normalize(event).facts);
    const materials = selectCanonicalInputMaterialFacts(facts);

    expect(materials.map((fact) => fact.part_key)).toEqual(["material/0", "material/1"]);
    expect(materials.every((fact) => fact.event_id === 3)).toBe(true);
    expect(materials.map((fact) => fact.source_key)).toEqual(["input/user", "input/user"]);
    expect(materials.some((fact) => fact.input_id === "input-hidden")).toBe(false);
    expect(materials.some((fact) => fact.quality.includes("unmatched_legacy_material"))).toBe(false);
    expect(facts.some((fact) => fact.quality.includes("unmatched_legacy_material"))).toBe(true);
    expect(facts.find((fact) => fact.event_id === 5 && fact.fact_kind === "boundary")?.quality).toContain("material_breakdown_unavailable");
    expect(facts.find((fact) => fact.event_id === 7 && fact.fact_kind === "boundary")?.quality).not.toContain("material_breakdown_unavailable");
  });

  it("uses A1's UTF-16 estimate for stored tool-result strings and does not retain the text", () => {
    const resultText = "safe tool result";
    const normalized = normalize({ sessionId: "tool", eventId: 100, eventType: "tool_result", createdAt: "2026-10-19T00:07:00Z", payload: { type: "tool_result", tool_use_id: "tool-1", result: resultText } });
    expect(normalized.facts[0]).toMatchObject({ fact_kind: "input_material", category: "tool_result", raw_chars_utf16: resultText.length, approximate_tokens: Math.ceil(resultText.length / 4) });
    expect(JSON.stringify(normalized)).not.toContain(resultText);
  });

  it("excludes unlinked keyless system text from material totals while retaining its source facts", () => {
    const facts = keylessSystemMaterialEvents.flatMap((event) => normalize(event).facts);
    const materials = selectCanonicalInputMaterialFacts(facts);

    expect(materials.map((fact) => ({
      eventId: fact.event_id,
      partKey: fact.part_key,
      sourceKey: fact.source_key,
      category: fact.category,
      approximateTokens: fact.approximate_tokens,
    }))).toEqual(expectedCanonicalInputMaterialFacts);
    expect(facts.find((fact) => fact.event_id === 101)).toMatchObject({
      raw_chars_utf16: 18,
      approximate_tokens: 5,
      quality: expect.arrayContaining(["unmatched_legacy_material"]),
    });
    expect(materials.some((fact) => fact.event_id === 101)).toBe(false);
  });

  it("applies the keyless legacy boundary rule to single, ambiguous, and separate complete owners", () => {
    const events = [
      { sessionId: "legacy", eventId: 1, eventType: "user_message", createdAt: "2026-10-19T00:08:00Z", payload: { type: "user_message", text: "safe one" } },
      { sessionId: "legacy", eventId: 2, eventType: "result", createdAt: "2026-10-19T00:08:01Z", payload: { type: "result", success: false, usage: { input_tokens: 10, output_tokens: 1 }, model: "gpt-6-luna" } },
      { sessionId: "legacy", eventId: 10, eventType: "user_message", createdAt: "2026-10-19T00:08:02Z", payload: { type: "user_message", text: "safe two" } },
      { sessionId: "legacy", eventId: 11, eventType: "result", createdAt: "2026-10-19T00:08:03Z", payload: { type: "result", success: false, usage: { input_tokens: 20, output_tokens: 2 }, model: "gpt-6-luna" } },
      { sessionId: "legacy", eventId: 12, eventType: "error", createdAt: "2026-10-19T00:08:04Z", payload: { type: "error", fatal: true, usage: { input_tokens: 21, output_tokens: 2 }, model: "gpt-6-luna" } },
      { sessionId: "legacy", eventId: 20, eventType: "user_message", createdAt: "2026-10-19T00:08:05Z", payload: { type: "user_message", text: "safe three" } },
      { sessionId: "legacy", eventId: 21, eventType: "result", createdAt: "2026-10-19T00:08:06Z", payload: { type: "result", success: false, usage: { input_tokens: 30, output_tokens: 3 }, model: "gpt-6-luna" } },
      { sessionId: "legacy", eventId: 22, eventType: "complete", createdAt: "2026-10-19T00:08:07Z", payload: { type: "complete", usage: { input_tokens: 40, output_tokens: 4 }, model: "gpt-6-luna" } },
      { sessionId: "legacy-unresolved", eventId: 30, eventType: "error", createdAt: "2026-10-19T00:08:08Z", payload: { type: "error", fatal: true, usage: { input_tokens: 50, output_tokens: 5 }, model: "gpt-6-luna" } },
    ];
    const selections = selectCanonicalUsageCandidates(events.flatMap((event) => normalize(event).facts));

    expect(selections).toContainEqual(expect.objectContaining({ state: "owned", ownerEventId: 2, candidateType: "failed_result" }));
    expect(selections).toContainEqual(expect.objectContaining({ state: "ambiguous_legacy", ownerEventId: null, quality: ["ambiguous_legacy_accounting"] }));
    expect(selections).toContainEqual(expect.objectContaining({ state: "owned", ownerEventId: 22, candidateType: "complete" }));
    expect(selections).toContainEqual(expect.objectContaining({ state: "unresolved_legacy", ownerEventId: null, candidateType: "failed_error", quality: ["unresolved_legacy_accounting"] }));
  });
});
