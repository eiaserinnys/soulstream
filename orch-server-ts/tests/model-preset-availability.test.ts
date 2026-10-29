import { describe, expect, it, vi } from "vitest";

import {
  resolvePresetAvailability,
  type ModelPresetAvailability,
  type StaticModelPreset,
} from "../src/model/model_preset_availability.js";
import type {
  UsageSummaryProvider,
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from "../src/usage/usage_summary_service.js";
import {
  getProviderLimitRejection,
  observeProviderExecution,
  type ProviderLimitProvider,
  type ProviderLimitRejection,
} from "../src/usage/provider_limit_rejection.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import type { NodeConnectionSnapshot } from "../src/node/registry_types.js";

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
        providers: { claude, codex: null, antigravity: null },
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
    antigravity: null,
  } as {
    claude: UsageSummaryProvider | null;
    codex: UsageSummaryProvider | null;
    antigravity: UsageSummaryProvider | null;
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

  it("keeps a pool node available when another authenticated account remains usable", () => {
    const result = resolvePresetAvailability(
      "node-a",
      preset,
      summary(poolProvider([poolAccount("account-a"), poolAccount("account-b")])),
      now,
      null,
      [{ accountId: "account-a", scope: "all", rejection: rejection("2026-07-28T04:00:00.000Z", "five_hour") }],
    );

    expect(result).toMatchObject({ available: true, reason: null, usage_warning: false });
  });

  it("applies a Fable-only rejection to Fable and leaves other Claude models available", () => {
    const usage = summary(poolProvider([poolAccount("account-a")]));
    const fableRejection = [{
      accountId: "account-a",
      scope: "fable" as const,
      rejection: rejection("2026-07-28T04:00:00.000Z", "seven_day"),
    }];

    expect(resolvePresetAvailability("node-a", preset, usage, now, null, fableRejection))
      .toMatchObject({ available: false, reason: "limit_rejected" });
    expect(resolvePresetAvailability(
      "node-a",
      { ...preset, id: "claude-sonnet", label: "Claude - Sonnet", usage_model_id: "sonnet" },
      usage,
      now,
      null,
      fableRejection,
    )).toMatchObject({ available: true, reason: null });
  });

  it("uses each account's maximum applicable reset and the pool's earliest finite reset", () => {
    const accounts = [
      poolAccount("account-a", { until: "2026-07-28T05:00:00.000Z", scope: "all" }),
      poolAccount("account-b", { until: "2026-07-28T04:00:00.000Z", scope: "all" }),
    ];
    const result = resolvePresetAvailability(
      "node-a",
      preset,
      summary(poolProvider(accounts)),
      now,
      null,
      [
        { accountId: "account-a", scope: "fable", rejection: rejection("2026-07-28T07:00:00.000Z", "seven_day") },
        { accountId: "account-b", scope: "fable", rejection: rejection("2026-07-28T06:00:00.000Z", "seven_day") },
      ],
    );

    expect(result).toMatchObject({
      available: false,
      reason: "limit_rejected",
      resets_at: "2026-07-28T06:00:00.000Z",
    });
  });

  it("uses worker scope summaries for separate all and Fable recovery times", () => {
    const account = poolAccount("account-a", { until: "2026-07-28T05:00:00.000Z", scope: "all" });
    const usage = summary(poolProvider([account], {
      pool: poolAggregate(0, 1, "2026-07-28T05:00:00.000Z"),
      fable_pool: poolAggregate(0, 1, "2026-07-28T07:00:00.000Z"),
    }));
    const allScopeEvent = [{
      accountId: account.id,
      scope: "all" as const,
      rejection: rejection("2026-07-28T05:00:00.000Z", "five_hour"),
    }];

    expect(resolvePresetAvailability("node-a", preset, usage, now))
      .toMatchObject({ available: false, reason: "limit_rejected", resets_at: "2026-07-28T07:00:00.000Z" });
    expect(resolvePresetAvailability("node-a", preset, usage, now, null, allScopeEvent))
      .toMatchObject({ available: false, reason: "limit_rejected", resets_at: "2026-07-28T07:00:00.000Z" });
    expect(resolvePresetAvailability(
      "node-a",
      { ...preset, id: "claude-sonnet", label: "Claude - Sonnet", usage_model_id: "sonnet" },
      usage,
      now,
    )).toMatchObject({ available: false, reason: "limit_rejected", resets_at: "2026-07-28T05:00:00.000Z" });
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      usage,
      new Date("2026-07-28T07:00:00.000Z"),
    )).toMatchObject({ available: true, reason: null });
  });

  it("keeps known auth failures and scoped rejection evidence when usage is stale", () => {
    for (const authState of ["needs_relogin", "logging_in"] as const) {
      expect(resolvePresetAvailability(
        "node-a",
        preset,
        summary(poolProvider([poolAccount("account-a", null, authState)]), true),
        now,
      )).toMatchObject({
        available: false,
        reason: "not_authenticated",
        usage_warning: true,
      });
    }

    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(poolProvider([poolAccount("account-a")], {
        pool: poolAggregate(0, 1, "2026-07-28T05:00:00.000Z"),
        fable_pool: poolAggregate(0, 1, "2026-07-28T07:00:00.000Z"),
      }), true),
      now,
    )).toMatchObject({
      available: false,
      reason: "limit_rejected",
      resets_at: "2026-07-28T07:00:00.000Z",
      usage_warning: true,
    });
  });

  it("keeps a finite recovery when another account is blocked indefinitely", () => {
    const result = resolvePresetAvailability(
      "node-a",
      preset,
      summary(poolProvider([
        poolAccount("account-a", { until: null, scope: "all" }),
        poolAccount("account-b", { until: "2026-07-28T06:00:00.000Z", scope: "all" }),
      ])),
      now,
    );

    expect(result).toMatchObject({ available: false, reason: "limit_rejected", resets_at: "2026-07-28T06:00:00.000Z" });
    expect(resolvePresetAvailability(
      "node-a", preset, summary(poolProvider([poolAccount("account-a", { until: null, scope: "all" })])), now,
    )).toMatchObject({ available: false, reason: "limit_rejected", resets_at: null });
  });

  it("treats idle accounts as runnable and fully disabled or unauthenticated pools as unavailable", () => {
    expect(resolvePresetAvailability(
      "node-a", preset, summary(poolProvider([poolAccount("account-a", null, "idle")])), now,
    )).toMatchObject({ available: true, reason: null, usage_warning: true });
    expect(resolvePresetAvailability(
      "node-a", preset, summary(poolProvider([poolAccount("account-a", null, "needs_relogin")])), now,
    )).toMatchObject({ available: false, reason: "not_authenticated" });
    expect(resolvePresetAvailability(
      "node-a", preset, summary(poolProvider([poolAccount("account-a", null, "ok", false)])), now,
    )).toMatchObject({ available: false, reason: "not_authenticated" });
  });

  it("uses a fresh provider authentication failure before a remembered rejection", () => {
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider({ status: "not_configured" })),
      now,
      rejection("2026-07-28T04:00:00.000Z", "five_hour"),
    )).toMatchObject({
      available: false,
      reason: "not_authenticated",
      reason_label: "미인증",
    });
  });

  it.each([
    ["fresh usage", summary(provider()), "한도 거부 중"],
    ["stale usage", summary(provider(), true), "한도 거부 중"],
    ["missing provider", summary(null, true), "한도 거부 중"],
    ["provider error", summary(provider({ status: "error" })), "한도 거부 중"],
  ] as const)("blocks a live rejection despite %s", (_label, usage, expectedLabel) => {
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      usage,
      now,
      rejection("2026-07-28T04:00:00.000Z", "unknown"),
    )).toMatchObject({
      available: false,
      reason: "limit_rejected",
      reason_label: expectedLabel,
      resets_at: "2026-07-28T04:00:00.000Z",
      usage_warning: false,
    });
  });

  it.each([
    ["five_hour", "5시간 한도 거부 중"],
    ["seven_day", "7일 한도 거부 중"],
    ["seven_day_primary", "7일 한도 거부 중"],
    ["custom", "한도 거부 중"],
    [null, "한도 거부 중"],
  ] as const)("labels the %s provider rejection", (rateLimitType, expected) => {
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(null, true),
      now,
      rejection("2026-07-28T04:00:00.000Z", rateLimitType),
    ).reason_label).toBe(expected);
  });

  it("expires a remembered rejection when now equals resetAt", () => {
    expect(resolvePresetAvailability(
      "node-a",
      preset,
      summary(provider()),
      now,
      rejection(now.toISOString(), "five_hour"),
    )).toMatchObject({ available: true, reason: null, usage_warning: false });
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
            antigravity: null,
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
          antigravity: null,
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

describe("ModelPresetAvailabilityService limit rejection", () => {
  it("keeps availability false for settings callers and reports the reset in the create error", () => {
    const activeRejection = rejection("2026-07-28T04:00:00.000Z", "five_hour");
    const service = new ModelPresetAvailabilityService(
      {
        getConnectedNode: () => ({
          nodeId: "node-a",
          capabilities: { claude_account_pool_v1: true },
          modelPresets: [preset],
        } as unknown as NodeConnectionSnapshot),
      },
      {
        getSummary: () => summary(provider()),
        getLimitRejection: () => activeRejection,
        getClaudePoolAccountsForAvailability: (_nodeId, accounts) => accounts,
      },
      () => now,
    );

    expect(service.listForNode("node-a")?.[0]).toMatchObject({
      available: false,
      reason: "limit_rejected",
      reason_label: "5시간 한도 거부 중",
      resets_at: "2026-07-28T04:00:00.000Z",
    });
    expect(() => service.requireAvailable("node-a", preset.id)).toThrowError(
      `Model preset '${preset.id}' is unavailable on node node-a: 5시간 한도 거부 중 (resets_at: 2026-07-28T04:00:00.000Z)`,
    );
    expect(service.requireAvailable("node-a", preset.id, { allowLimitRejected: true }))
      .toMatchObject({ available: false, reason: "limit_rejected" });
  });

  it("uses UUID-correlated account observations when resolving pool availability", () => {
    const account = poolAccount("account-a");
    const observedAccount = {
      ...account,
      blocked: { until: "2026-07-28T04:00:00.000Z", scope: "all" as const },
      peer_blocks: [{ until: "2026-07-28T04:00:00.000Z", scope: "all" as const }],
      observed_at: "2026-07-28T03:30:00.000Z",
    };
    const getClaudePoolAccountsForAvailability = vi.fn(
      (_nodeId: string, accounts: readonly typeof account[]) =>
        accounts.map((candidate) => candidate.id === account.id ? observedAccount : candidate),
    );
    const service = new ModelPresetAvailabilityService(
      {
        getConnectedNode: () => ({
          nodeId: "node-a",
          capabilities: { claude_account_pool_v1: true },
          modelPresets: [preset],
        } as unknown as NodeConnectionSnapshot),
      },
      {
        getSummary: () => summary(poolProvider([account])),
        getLimitRejection: () => null,
        getClaudePoolAccountsForAvailability,
      },
      () => now,
    );

    expect(service.listForNode("node-a")?.[0]).toMatchObject({
      available: false,
      reason: "limit_rejected",
      resets_at: "2026-07-28T04:00:00.000Z",
    });
    expect(getClaudePoolAccountsForAvailability).toHaveBeenCalledWith("node-a", [account]);
  });

  it("uses legacy scalar availability immediately after pool capability is withdrawn", () => {
    const node = {
      nodeId: "node-a",
      capabilities: {},
      modelPresets: [preset],
    } as unknown as NodeConnectionSnapshot;
    const getClaudePoolAccountsForAvailability = vi.fn(
      (_nodeId: string, accounts: readonly ReturnType<typeof poolAccount>[]) => accounts,
    );
    const service = new ModelPresetAvailabilityService(
      { getConnectedNode: () => node },
      {
        getSummary: () => summary(poolProvider([
          poolAccount("account-a", { until: "2026-07-28T07:00:00.000Z", scope: "all" }),
        ], {
          pool: poolAggregate(0, 1, "2026-07-28T07:00:00.000Z"),
          fable_pool: poolAggregate(0, 1, "2026-07-28T07:00:00.000Z"),
        })),
        getLimitRejection: () => null,
        getClaudePoolAccountsForAvailability,
      },
      () => now,
    );

    expect(service.listForNode("node-a")?.[0]).toEqual({
      id: "claude-fable",
      label: "Claude - Fable",
      backend: "claude",
      available: true,
      reason: null,
      reason_label: null,
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
    expect(getClaudePoolAccountsForAvailability).not.toHaveBeenCalled();
  });
});

describe("ModelPresetAvailabilityService usable preset selection", () => {
  const candidateIds = ["gemini-4-argon", "claude-opus", "codex-6.1-sol"];

  it.each([
    ["keeps the first preset when it has headroom", [
      presetAvailability("gemini-4-argon", true, 50),
      presetAvailability("claude-opus", true, 60),
      presetAvailability("codex-6.1-sol", true, 80),
    ], "gemini-4-argon"],
    ["keeps the first preset when no weekly quota is reported", [
      presetAvailability("gemini-4-argon", true, null),
      presetAvailability("claude-opus", true, 60),
      presetAvailability("codex-6.1-sol", true, 80),
    ], "gemini-4-argon"],
    ["moves past the first preset below the weekly floor", [
      presetAvailability("gemini-4-argon", true, 0.33),
      presetAvailability("claude-opus", true, 60),
      presetAvailability("codex-6.1-sol", true, 80),
    ], "claude-opus"],
    ["uses the third preset when the first two are unavailable", [
      presetAvailability("gemini-4-argon", true, 0.33),
      presetAvailability("claude-opus", false, null),
      presetAvailability("codex-6.1-sol", true, 83),
    ], "codex-6.1-sol"],
    ["uses the third preset when the first two are limit-rejected", [
      presetAvailability("gemini-4-argon", false, null),
      presetAvailability("claude-opus", false, null),
      presetAvailability("codex-6.1-sol", true, 83),
    ], "codex-6.1-sol"],
    ["falls back to the first available preset when all are below the floor", [
      presetAvailability("gemini-4-argon", true, 0.33),
      presetAvailability("claude-opus", true, 0.5),
      presetAvailability("codex-6.1-sol", true, 0.75),
    ], "gemini-4-argon"],
  ])("%s", (_label, availability, expected) => {
    const service = createSelectionService(availability as ModelPresetAvailability[]);
    expect(service.chooseUsablePreset("node-a", candidateIds)).toBe(expected);
  });

  it("skips candidate presets the node does not advertise", () => {
    const service = createSelectionService([
      presetAvailability("claude-opus", true, 60),
      presetAvailability("codex-6.1-sol", true, 80),
    ]);
    expect(service.chooseUsablePreset("node-a", candidateIds)).toBe("claude-opus");
  });

  it("chooses the first candidate when none is available", () => {
    const service = createSelectionService([
      presetAvailability("gemini-4-argon", false, null),
      presetAvailability("claude-opus", false, null),
      presetAvailability("codex-6.1-sol", false, null),
    ]);
    expect(service.chooseUsablePreset("node-a", candidateIds)).toBe("gemini-4-argon");
  });
});

function createSelectionService(availability: ModelPresetAvailability[]) {
  const service = new ModelPresetAvailabilityService(
    { getConnectedNode: () => undefined },
    {
      getSummary: () => summary(null),
      getLimitRejection: () => null,
      getClaudePoolAccountsForAvailability: (_nodeId, accounts) => accounts,
    },
    () => now,
  );
  vi.spyOn(service, "listForNode").mockReturnValue(availability);
  return service;
}

function presetAvailability(
  id: string,
  available: boolean,
  remainingPercent: number | null,
): ModelPresetAvailability {
  return {
    id,
    label: id,
    backend: id === "gemini-4-argon" ? "antigravity" : id === "claude-opus" ? "claude" : "codex",
    available,
    reason: available ? null : "limit_rejected",
    reason_label: available ? null : "한도 거부 중",
    resets_at: null,
    usage_warning: false,
    weekly_headroom: remainingPercent === null ? null : {
      status: "ok",
      headroom: remainingPercent,
      remaining_percent: remainingPercent,
      window_remaining_percent: remainingPercent,
      resets_at: null,
      observed_at: now.toISOString(),
      quota_label: "7일",
    },
  };
}

function rejection(rejectedUntil: string | null, rateLimitType: string | null): ProviderLimitRejection {
  return { rejectedUntil, rateLimitType, observedAt: "2026-07-28T02:59:00.000Z" };
}

function poolProvider(
  accounts: ReturnType<typeof poolAccount>[],
  overrides: {
    pool?: NonNullable<UsageSummaryProvider["pool"]>;
    fable_pool?: UsageSummaryProvider["fable_pool"];
  } = {},
): UsageSummaryProvider {
  return provider({
    mode: "pool",
    accounts,
    pool: overrides.pool ?? poolAggregateForAccounts(accounts, "all"),
    fable_pool: overrides.fable_pool ?? poolAggregateForAccounts(accounts, "fable"),
  });
}

function poolAggregate(
  available_count: number,
  total_count: number,
  earliest_available_at: string | null,
): NonNullable<UsageSummaryProvider["pool"]> {
  return {
    available_count,
    total_count,
    best_weekly_remaining_percent: null,
    best_weekly_resets_at: null,
    earliest_available_at,
  };
}

function poolAggregateForAccounts(
  accounts: ReturnType<typeof poolAccount>[],
  scope: "all" | "fable",
): NonNullable<UsageSummaryProvider["pool"]> {
  const enabled = accounts.filter((account) => account.enabled);
  const eligible = enabled.filter((account) =>
    account.auth_state === "ok" || account.auth_state === "idle");
  const blocked = eligible.filter((account) => account.blocked !== null && (
    account.blocked.scope === "all" || scope === "fable"
  ));
  const available = eligible.length - blocked.length;
  const finiteResets = blocked
    .map((account) => account.blocked?.until)
    .filter((value): value is string => value !== null && value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return poolAggregate(enabled.length > 0 ? available : 0, enabled.length,
    available === 0 ? finiteResets[0] ?? null : null);
}

function poolAccount(
  id: string,
  blocked: { until: string | null; scope: "all" | "fable" } | null = null,
  auth_state: "ok" | "idle" | "needs_relogin" | "logging_in" = "ok",
  enabled = true,
) {
  return {
    id,
    email: `${id}@example.com`,
    plan: null,
    enabled,
    priority: null,
    auth_state,
    usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: null,
    blocked,
    active_sessions: 0,
  } as const;
}

it("uses Antigravity group quotas for both presets and existing availability states", () => {
  const usage = summary(null);
  const agy = provider({ quotas: [{ id: "antigravity:gemini:weekly", label: "7일", window: "7d", model: null, remainingPercent: 90, resetAt: now.getTime()/1000 + 86400 }] });
  const nodes = [{ ...usage.nodes[0]!, providers: { ...usage.nodes[0]!.providers, antigravity: agy } }];
  for (const id of ["gemini-3.8-flash", "gemini-4-argon"]) {
    const agyPreset = { ...preset, id, backend: "antigravity" as const, usage_provider: "antigravity" as const, usage_model_id: id };
    const result = resolvePresetAvailability("node-a", agyPreset, { ...usage, nodes }, now);
    expect(result.available).toBe(true);
    expect(result.weekly_headroom?.headroom).toEqual(expect.any(Number));
    expect(resolvePresetAvailability("node-a", agyPreset, { ...usage, nodes: [{ ...nodes[0]!, stale: true }] }, now).usage_warning).toBe(true);
    expect(resolvePresetAvailability("node-a", agyPreset, { ...usage, nodes: [{ ...nodes[0]!, providers: { ...nodes[0]!.providers, antigravity: provider({ status: "not_configured" }) } }] }, now).available).toBe(false);
    expect(resolvePresetAvailability("node-a", agyPreset, { ...usage, nodes: [{ ...nodes[0]!, providers: { ...nodes[0]!.providers, antigravity: provider({ quotas: [{ ...agy.quotas[0]!, remainingPercent: 0 }] }) } }] }, now).available).toBe(true);
  }
});

it("accepts advertised Antigravity presets in the shared node-list API availability service", () => {
  const usage = summary(null);
  const antigravity = provider({ quotas: [{ id: "antigravity:gemini:weekly", label: "7일", window: "7d", model: null, remainingPercent: 90, resetAt: now.getTime() / 1000 + 86400 }] });
  const presets = ["gemini-3.8-flash", "gemini-4-argon"].map(id => ({ ...preset, id, backend: "antigravity", usage_provider: "antigravity", usage_model_id: id }));
  const service = new ModelPresetAvailabilityService(
    { getConnectedNode: () => ({ nodeId: "node-a", modelPresets: presets } as unknown as NodeConnectionSnapshot) },
    {
      getSummary: () => ({ ...usage, nodes: [{ ...usage.nodes[0]!, providers: { ...usage.nodes[0]!.providers, antigravity } }] }),
      getLimitRejection: () => null,
      getClaudePoolAccountsForAvailability: (_nodeId, accounts) => accounts,
    },
    () => now,
  );
  expect(service.listForNode("node-a")).toEqual(presets.map(p => expect.objectContaining({ id: p.id, backend: "antigravity", available: true, weekly_headroom: expect.objectContaining({ headroom: expect.any(Number), remaining_percent: 90 }) })));
  expect(service.requireAvailable("node-a", "gemini-4-argon").id).toBe("gemini-4-argon");
});

it("rejects an Antigravity preset after quota error and selects the usable fallback", () => {
  const memory = new Map<string, ProviderLimitRejection>();
  const resetsAt = "2026-07-28T04:00:00.000Z";
  const sharedAccountGroups: Array<{ provider: string; nodeIds: readonly string[] }> = [];
  observeProviderExecution({
    memory,
    sharedAccountGroups,
    event: {
      nodeId: "node-a",
      eventType: "error",
      payload: { type: "error", error_code: "antigravity_quota_exceeded", resets_at: resetsAt },
      createdAt: "2026-07-28T02:59:00.000Z",
    },
    now,
  });

  const presets: StaticModelPreset[] = [
    { id: "gemini-4-argon", label: "Gemini - 4 Argon", backend: "antigravity", available: true,
      usage_provider: "antigravity", usage_model_id: "gemini-4-argon" },
    { id: "claude-opus", label: "Claude - Opus", backend: "claude", available: true,
      usage_provider: "claude", usage_model_id: "claude-opus" },
    { id: "codex-6.1-sol", label: "Codex - 6.1 Sol", backend: "codex", available: true,
      usage_provider: "codex", usage_model_id: "gpt-6.1-sol" },
  ];
  const usage = summary(null);
  const resetSeconds = Math.floor(Date.parse(resetsAt) / 1_000);
  const service = new ModelPresetAvailabilityService(
    { getConnectedNode: () => ({ nodeId: "node-a", modelPresets: presets } as unknown as NodeConnectionSnapshot) },
    {
      getSummary: () => ({
        ...usage,
        nodes: [{
          ...usage.nodes[0]!,
          providers: {
            claude: provider({ quotas: [{ id: "claude:weekly", label: "7일", window: "7d",
              model: "claude-opus", remainingPercent: 0, resetAt: resetSeconds }] }),
            codex: provider({ quotas: [{ id: "codex:weekly", label: "7일", window: "7d",
              model: "gpt-6.1-sol", remainingPercent: 81, resetAt: resetSeconds }] }),
            antigravity: provider({ quotas: [{ id: "antigravity:weekly", label: "7일", window: "7d",
              model: "gemini-4-argon", remainingPercent: 90, resetAt: resetSeconds }] }),
          },
        }],
      }),
      getLimitRejection: (nodeId, providerName: ProviderLimitProvider) => getProviderLimitRejection({
        memory,
        sharedAccountGroups,
        nodeId,
        provider: providerName,
        now,
      }),
      getClaudePoolAccountsForAvailability: (_nodeId, accounts) => accounts,
    },
    () => now,
  );

  expect(service.resolveForNode("node-a", "gemini-4-argon")).toMatchObject({
    available: false,
    reason: "limit_rejected",
    resets_at: resetsAt,
  });
  expect(service.chooseUsablePreset("node-a", ["gemini-4-argon", "claude-opus", "codex-6.1-sol"]))
    .toBe("codex-6.1-sol");
});
