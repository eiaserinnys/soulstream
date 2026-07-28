import { describe, expect, it } from "vitest";

import {
  resolvePresetAvailability,
  type StaticModelPreset,
} from "../src/model/model_preset_availability.js";
import type {
  UsageSummaryProvider,
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

  it("blocks an active matching quota and exposes its reset as ISO", () => {
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
      available: false,
      reason: "quota_exhausted",
      reason_label: "Fable 사용량 제한",
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
      available: false,
      reason_label: "7일 사용량 제한",
    });
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
