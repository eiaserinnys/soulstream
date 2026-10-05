import { describe, expect, it } from "vitest";

import {
  resolvePresetAvailability,
  type StaticModelPreset,
} from "../src/model/model_preset_availability.js";
import type {
  UsageSummaryProvider,
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from "../src/usage/usage_summary_service.js";

const preset: StaticModelPreset = {
  id: "claude-fable",
  label: "Claude - Fable",
  backend: "claude",
  available: true,
  usage_provider: "claude",
  usage_model_id: "fable",
};

const now = new Date("2026-07-28T03:00:00.000Z");

function provider(
  overrides: Partial<UsageSummaryProvider> = {},
): UsageSummaryProvider {
  return {
    status: "auto",
    weeklyRemainingPercent: 50,
    weeklyResetAt: null,
    shortRemainingPercent: 50,
    shortResetAt: null,
    quotas: [],
    ...overrides,
  };
}

function summary(
  claude: UsageSummaryProvider | null,
  stale = false,
): UsageSummarySnapshot {
  return {
    generatedAt: now.toISOString(),
    collectedAt: now.toISOString(),
    nodes: [
      {
        nodeId: "node-a",
        fetchedAt: now.toISOString(),
        stale,
        staleSince: stale ? now.toISOString() : null,
        providers: { claude, codex: null, gemini: null },
      },
    ],
  };
}

function quotaSummary(
  providerName: "claude" | "codex",
  quota: UsageSummaryQuota,
): UsageSummarySnapshot {
  const providers = {
    claude: null,
    codex: null,
    gemini: null,
  } as {
    claude: UsageSummaryProvider | null;
    codex: UsageSummaryProvider | null;
    gemini: UsageSummaryProvider | null;
  };
  providers[providerName] = provider({ quotas: [quota] });
  return {
    ...summary(null),
    nodes: [{
      nodeId: "node-a",
      fetchedAt: now.toISOString(),
      stale: false,
      staleSince: null,
      providers,
    }],
  };
}

describe("resolvePresetAvailability", () => {
  it("blocks statically unresolved env before applying usage", () => {
    expect(resolvePresetAvailability(
      "node-a",
      { ...preset, available: false, reason: "env_unresolved" },
      summary(provider()),
      now,
    )).toEqual({
      id: "claude-fable",
      label: "Claude - Fable",
      backend: "claude",
      available: false,
      reason: "env_unresolved",
      reason_label: "키 미설정",
      resets_at: null,
      usage_warning: false,
      weekly_headroom: {
        status: "unavailable",
        headroom: null,
        remaining_percent: null,
        window_remaining_percent: null,
        resets_at: null,
        observed_at: null,
        quota_label: null,
      },
    });
  });

  it("blocks not_configured as not_authenticated", () => {
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider({ status: "not_configured" })),
      now,
    )).toMatchObject({
      available: false,
      reason: "not_authenticated",
      reason_label: "미인증",
      usage_warning: false,
    });
  });

  it("allows an active matching quota and exposes its reset as ISO", () => {
    const resetAt = Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000);
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider({
        quotas: [
          {
            id: "claude:weekly_scoped:fable",
            label: "Fable",
            window: "7d",
            model: "Fable",
            remainingPercent: 0,
            resetAt,
          },
        ],
      })),
      now,
    )).toMatchObject({
      available: true,
      reason: "quota_exhausted",
      reason_label: "7일 (Fable) 사용량 제한",
      resets_at: "2026-07-28T04:00:00.000Z",
    });
  });

  it("uses the collector quota label instead of exposing raw window identities", () => {
    const resetAt = Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000);
    expect(resolvePresetAvailability(
      "node-a",
      {
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
        usage_model_id: "gpt-5.6-sol",
      },
      {
        ...summary(null),
        nodes: [{
          nodeId: "node-a",
          fetchedAt: now.toISOString(),
          stale: false,
          staleSince: null,
          providers: {
            claude: null,
            codex: provider({
              quotas: [{
                id: "codex:weekly",
                label: "7일",
                window: "168h",
                model: null,
                remainingPercent: 0,
                resetAt,
              }],
            }),
            gemini: null,
          },
        }],
      },
      now,
    )).toMatchObject({
      available: true,
      reason_label: "7일 사용량 제한",
    });
  });

  it.each([
    {
      name: "Claude 5h",
      preset,
      providerName: "claude" as const,
      quota: {
        id: "claude:five_hour",
        label: "5시간",
        window: "5h",
        model: null,
        remainingPercent: 0,
        resetAt: Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000),
      },
      expected: "5시간 사용량 제한",
    },
    {
      name: "Claude 7d",
      preset,
      providerName: "claude" as const,
      quota: {
        id: "claude:seven_day",
        label: "7일",
        window: "7d",
        model: null,
        remainingPercent: 0,
        resetAt: Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000),
      },
      expected: "7일 사용량 제한",
    },
    {
      name: "Claude weekly_scoped Fable",
      preset,
      providerName: "claude" as const,
      quota: {
        id: "claude:weekly_scoped:fable",
        label: "Fable",
        window: "7d",
        model: "Fable",
        remainingPercent: 0,
        resetAt: Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000),
      },
      expected: "7일 (Fable) 사용량 제한",
    },
    {
      name: "Codex 7d",
      preset: {
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex" as const,
        available: true,
        usage_provider: "codex" as const,
        usage_model_id: "gpt-5.6-sol",
      },
      providerName: "codex" as const,
      quota: {
        id: "codex:7d",
        label: "7일",
        window: "168h",
        model: null,
        remainingPercent: 0,
        resetAt: Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000),
      },
      expected: "7일 사용량 제한",
    },
    {
      name: "Codex Spark 5h",
      preset: {
        id: "codex-spark",
        label: "Codex - Spark",
        backend: "codex" as const,
        available: true,
        usage_provider: "codex" as const,
        usage_model_id: "gpt-5.3-codex-spark",
      },
      providerName: "codex" as const,
      quota: {
        id: "codex:gpt-5.3-codex-spark:primary",
        label: "GPT-5.3-Codex-Spark 5시간",
        window: "168h",
        model: "gpt-5.3-codex-spark",
        remainingPercent: 0,
        resetAt: Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000),
      },
      expected: "GPT-5.3-Codex-Spark 5시간 사용량 제한",
    },
  ])("renders the live quota label for $name", ({
    preset: casePreset,
    providerName,
    quota,
    expected,
  }) => {
    expect(resolvePresetAvailability(
      "node-a",
      casePreset,
      quotaSummary(providerName, quota),
      now,
    ).reason_label).toBe(expected);
  });

  it("self-releases an exhausted quota after its reset before the next poll", () => {
    const resetAt = Math.floor(Date.parse("2026-07-28T02:59:59.000Z") / 1_000);
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider({
        quotas: [
          {
            id: "claude:five_hour",
            label: "5시간",
            window: "5h",
            model: null,
            remainingPercent: 0,
            resetAt,
          },
        ],
      })),
      now,
    )).toMatchObject({
      available: true,
      reason: null,
      usage_warning: false,
    });
  });

  it("does not apply a model-scoped Codex quota to a different preset", () => {
    const usage: UsageSummarySnapshot = {
      ...summary(null),
      nodes: [{
        nodeId: "node-a",
        fetchedAt: now.toISOString(),
        stale: false,
        staleSince: null,
        providers: {
          claude: null,
          codex: provider({
            quotas: [
              {
                id: "codex:model:lunar",
                label: "Lunar",
                window: "7d",
                model: "gpt-5.6-lunar",
                remainingPercent: 0,
                resetAt:
                  Math.floor(Date.parse("2026-07-28T04:00:00.000Z") / 1_000),
              },
            ],
          }),
          gemini: null,
        },
      }],
    };
    expect(resolvePresetAvailability(
      "node-a",
      {
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
        usage_model_id: "gpt-5.6-sol",
      },
      usage,
      now,
    )).toMatchObject({
      available: true,
      reason: null,
      usage_warning: false,
    });
  });

  it("uses the lowest applicable 7-day candidate and excludes short or other-model quotas", () => {
    const weeklyResetAt = now.getTime() / 1_000 + 565_488;
    const quotaResetAt = now.getTime() / 1_000 + 7 * 24 * 60 * 60;
    const availability = resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider({
        weeklyRemainingPercent: 83,
        weeklyResetAt,
        observedAt: now.toISOString(),
        quotas: [
          {
            id: "claude:five_hour",
            label: "5시간",
            window: "5h",
            model: null,
            remainingPercent: 0,
            resetAt: now.getTime() / 1_000 + 60,
          },
          {
            id: "claude:weekly:other",
            label: "Other model",
            window: "7d",
            model: "Other",
            remainingPercent: 1,
            resetAt: quotaResetAt,
          },
          {
            id: "claude:weekly:fable",
            label: "Fable",
            window: "168h",
            model: "Fable",
            remainingPercent: 30,
            resetAt: quotaResetAt,
          },
        ],
      })),
      now,
    );

    expect(availability.weekly_headroom).toEqual({
      status: "ok",
      headroom: -70,
      remaining_percent: 30,
      window_remaining_percent: 100,
      resets_at: new Date(quotaResetAt * 1_000).toISOString(),
      observed_at: now.toISOString(),
      quota_label: "Fable",
    });
  });

  it("returns null headroom when the preset has no usage provider", () => {
    expect(resolvePresetAvailability(
      "node-a",
      { ...preset, usage_provider: null },
      summary(provider({ weeklyRemainingPercent: 80 })),
      now,
    ).weekly_headroom).toBeNull();
  });

  it("keeps the last successful value and marks it stale with a stale node snapshot", () => {
    const resetAt = now.getTime() / 1_000 + 7 * 24 * 60 * 60;
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider({
        weeklyRemainingPercent: 61,
        weeklyResetAt: resetAt,
        observedAt: now.toISOString(),
      }), true),
      now,
    ).weekly_headroom).toMatchObject({
      status: "stale",
      headroom: -39,
      remaining_percent: 61,
    });
  });

  it.each([
    ["missing provider", summary(null)],
    ["provider error", summary(provider({ status: "error" }))],
    ["missing weekly numbers", summary(provider())],
  ])("marks %s weekly data unavailable", (_label, usage) => {
    expect(resolvePresetAvailability("node-a", preset, usage, now).weekly_headroom)
      .toMatchObject({
        status: "unavailable",
        headroom: null,
        remaining_percent: null,
        window_remaining_percent: null,
      });
  });

  it.each([
    ["provider error", summary(provider({ status: "error" }))],
    ["stale snapshot", summary(provider({ status: "not_configured" }), true)],
  ])("keeps the preset selectable with a warning for %s", (_label, usage) => {
    expect(resolvePresetAvailability("node-a", preset, usage, now)).toMatchObject({
      available: true,
      reason: null,
      usage_warning: true,
    });
  });
});
