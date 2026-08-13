import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import {
  ProviderUsageService,
  claudeLimitsFromUsageResponse,
  codexLimitsFromUsageResponse,
  geminiLimitsFromQuotaResponse,
} from "../../src/auth/provider_usage.js";
import type { ClaudeAuthCommandHandler } from "../../src/auth/claude_auth.js";
import { providerUsageEndpoint } from "../../src/auth/provider_usage_telemetry.js";

function fetchJson(payload: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

interface CapturedLog {
  level: "debug" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

function captureLogger(): {
  logger: Pick<Logger, "debug" | "warn">;
  entries: CapturedLog[];
} {
  const entries: CapturedLog[] = [];
  const logger = {
    debug(fields: Record<string, unknown>, message: string) {
      entries.push({ level: "debug", fields, message });
    },
    warn(fields: Record<string, unknown>, message: string) {
      entries.push({ level: "warn", fields, message });
    },
  } as unknown as Pick<Logger, "debug" | "warn">;
  return { logger, entries };
}

function hangingFetch(): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("provider usage fetch did not receive an AbortSignal");
    }
    return await new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
  }) as unknown as typeof fetch;
}

describe("ProviderUsageService", () => {
  it("reduces telemetry endpoints to host and path", () => {
    expect(
      providerUsageEndpoint(
        "https://user:password@example.com/provider/usage?access_token=secret#fragment",
      ),
    ).toBe("example.com/provider/usage");
  });

  it("bounds slow Codex requests, warns with safe endpoint fields, and never logs credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-timeout-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "codex-access-secret",
            refresh_token: "codex-refresh-secret",
            account_id: "acct-secret",
          },
        }),
      );
      const { logger, entries } = captureLogger();
      const fetchImpl = hangingFetch();
      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl,
        logger,
        requestTimeoutMs: 25,
      });

      const startedAt = Date.now();
      const result = await service.fetchUsage("req-timeout", "provider_usage_get", "codex");
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(500);
      expect(result).toMatchObject({
        success: true,
        data: { status: "error" },
      });
      expect(fetchImpl).toHaveBeenCalled();
      const requestSignals = vi.mocked(fetchImpl).mock.calls.map((call) => call[1]?.signal);
      expect(requestSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
      expect(new Set(requestSignals).size).toBe(1);
      expect(
        entries.some(
          (entry) =>
            entry.level === "debug"
            && entry.fields.provider === "codex"
            && entry.fields.endpoint === "chatgpt.com/backend-api/codex/usage"
            && entry.fields.result === "started"
            && entry.fields.durationMs === 0,
        ),
      ).toBe(true);
      expect(
        entries.some(
          (entry) =>
            entry.level === "warn"
            && entry.fields.provider === "codex"
            && entry.fields.endpoint === "chatgpt.com/backend-api/codex/usage"
            && entry.fields.result === "timeout"
            && typeof entry.fields.durationMs === "number",
        ),
      ).toBe(true);
      const serializedLogs = JSON.stringify(entries);
      expect(serializedLogs).not.toContain("codex-access-secret");
      expect(serializedLogs).not.toContain("codex-refresh-secret");
      expect(serializedLogs).not.toContain("acct-secret");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not start an orphaned Codex rollout scan after the provider signal aborts", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-aborted-fallback-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: "codex-access-secret" } }),
      );
      const { logger, entries } = captureLogger();
      const codexRuntimeLimitsImpl = vi.fn(() => {
        throw new Error("orphaned rollout scan was invoked");
      });
      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl: hangingFetch(),
        logger,
        requestTimeoutMs: 25,
        codexRuntimeLimitsImpl,
      });

      const result = await service.fetchUsage("req-aborted-fallback", "provider_usage_get", "codex");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(result).toMatchObject({ success: true, data: { status: "error" } });
      expect(codexRuntimeLimitsImpl).not.toHaveBeenCalled();
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({
            provider: "codex",
            result: "fallback_skipped",
            reason: "remote_usage_unavailable",
            aborted: true,
          }),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bounds a provider implementation even when it ignores the AbortSignal", async () => {
    const { logger, entries } = captureLogger();
    const claudeAuth = {
      fetchUsage: vi.fn(async () => await new Promise<never>(() => undefined)),
    } as unknown as ClaudeAuthCommandHandler;
    const service = new ProviderUsageService({
      claudeAuth,
      logger,
      requestTimeoutMs: 25,
    });

    const startedAt = Date.now();
    const result = await service.fetchUsage("req-hard-timeout", "provider_usage_get", "claude");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(result).toMatchObject({ success: true, data: { status: "error" } });
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          provider: "claude",
          endpoint: "api.anthropic.com/api/oauth/usage",
          result: "timeout",
          durationMs: expect.any(Number),
        }),
      }),
    );
  });

  it("keeps successful provider results when another provider throws", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-partial-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: "codex-access" } }),
      );
      const claudeAuth = {
        fetchUsage: vi.fn(async () => {
          throw new Error("Claude usage exploded");
        }),
      } as unknown as ClaudeAuthCommandHandler;
      const { logger, entries } = captureLogger();
      const service = new ProviderUsageService({
        homeDir: home,
        claudeAuth,
        fetchImpl: fetchJson({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 19,
              reset_at: 1779550026,
              limit_window_seconds: 18000,
            },
          },
        }),
        logger,
        slowRequestThresholdMs: 0,
      });

      const result = await service.fetchUsage("req-partial", "provider_usage_get");

      expect(result).toMatchObject({
        success: true,
        data: {
          providers: {
            claude: { status: "error" },
            codex: { status: "auto", shortUsedPercent: 19 },
            gemini: { status: "not_configured" },
          },
        },
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({
            provider: "codex",
            endpoint: "chatgpt.com/backend-api/codex/usage",
            result: "success",
            durationMs: expect.any(Number),
          }),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("logs entry into the local Codex rollout fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-fallback-"));
    try {
      const { logger, entries } = captureLogger();
      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl: fetchJson({}),
        logger,
      });

      await service.fetchUsage("req-fallback", "provider_usage_get", "codex");

      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({
            provider: "codex",
            endpoint: "filesystem/.codex/sessions",
            durationMs: 0,
            result: "fallback",
            reason: "oauth_not_configured",
            aborted: false,
          }),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("normalizes ISO resets and generic weekly_scoped Claude limits", () => {
    const limits = claudeLimitsFromUsageResponse({
      five_hour: {
        utilization: 37,
        resets_at: "2026-07-20T14:20:00.212584+00:00",
      },
      seven_day: {
        utilization: 18,
        resets_at: "2026-07-26T22:00:00.212608+00:00",
      },
      seven_day_omelette: null,
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 16,
          resets_at: "2026-07-26T22:00:00.248331+00:00",
          scope: {
            model: {
              id: null,
              display_name: "Fable",
            },
            surface: null,
          },
          is_active: false,
        },
      ],
    });

    expect(limits).toMatchObject({
      shortUsedPercent: 37,
      shortResetAt: Math.floor(Date.parse("2026-07-20T14:20:00.212584+00:00") / 1000),
      weeklyUsedPercent: 18,
      weeklyResetAt: Math.floor(Date.parse("2026-07-26T22:00:00.212608+00:00") / 1000),
    });
    expect(limits.quotas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude:weekly_scoped:fable",
          label: "Fable",
          window: "7d",
          usedPercent: 16,
          remainingPercent: 84,
          resetAt: Math.floor(Date.parse("2026-07-26T22:00:00.248331+00:00") / 1000),
          model: "Fable",
        }),
      ]),
    );
  });

  it("uses dynamic and catalog labels for model-scoped Claude quotas without hardcoded model names", () => {
    const limits = claudeLimitsFromUsageResponse(
      {
        five_hour: { utilization: 10, resets_at: 1784951000 },
        seven_day: { utilization: 20, resets_at: 1784952000 },
        seven_day_sonnet: { utilization: 21, resets_at: 1784952100 },
        seven_day_opus: { utilization: 22, resets_at: 1784952200 },
        seven_day_fable: {
          utilization: 30,
          resets_at: 1784953000,
        },
        seven_day_nova: {
          display_name: "Nova",
          utilization: 40,
          resets_at: 1784954000,
        },
        seven_day_unknown: {
          utilization: 50,
          resets_at: 1784955000,
        },
      },
      "test",
      [
        {
          id: "claude-fable",
          label: "Claude - Fable",
          backend: "claude",
          model: "claude-fable-5[1m]",
          usage_model_id: "fable",
        },
      ],
    );

    expect(limits.quotas.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "claude:five_hour", label: "5시간" },
      { id: "claude:seven_day", label: "7일" },
      { id: "claude:seven_day_sonnet", label: "7일 (Sonnet)" },
      { id: "claude:seven_day_opus", label: "7일 (Opus)" },
      { id: "claude:seven_day_fable", label: "7일 (Fable)" },
      { id: "claude:seven_day_nova", label: "7일 (Nova)" },
      { id: "claude:seven_day_unknown", label: "seven_day_unknown" },
    ]);
  });

  it("classifies a single Codex primary window by its seven-day duration", () => {
    const limits = codexLimitsFromUsageResponse({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 80,
          limit_window_seconds: 604800,
          reset_after_seconds: 396892,
          reset_at: 1784951882,
        },
        secondary_window: null,
      },
    });

    expect(limits).toMatchObject({
      shortUsedPercent: null,
      weeklyUsedPercent: 80,
      weeklyResetAt: 1784951882,
      quotas: [
        expect.objectContaining({
          id: "codex:7d",
          label: "7일",
          window: "168h",
          usedPercent: 80,
          remainingPercent: 20,
        }),
      ],
    });
  });

  it("reads Codex OAuth credentials and normalizes 5h/7d usage windows", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "codex-access",
            account_id: "acct-1",
          },
        }),
      );
      const fetchImpl = fetchJson({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 19,
            reset_at: 1779550026,
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 12,
            reset_at: 1780118811,
            limit_window_seconds: 604800,
          },
        },
      });

      const service = new ProviderUsageService({ homeDir: home, fetchImpl });
      const result = await service.fetchUsage("req-1", "provider_usage_get", "codex");

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        planType: "pro",
        shortUsedPercent: 19,
        weeklyUsedPercent: 12,
        quotas: [
          { id: "codex:5h", label: "5시간", usedPercent: 19 },
          { id: "codex:7d", label: "7일", usedPercent: 12 },
        ],
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/codex/usage",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer codex-access",
            "chatgpt-account-id": "acct-1",
          }),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to latest local Codex session rate_limits when OAuth is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-"));
    try {
      const sessionDir = join(home, ".codex", "sessions", "2026", "05", "23");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "rollout-test.jsonl"),
        `${JSON.stringify({
          payload: {
            type: "token_count",
            rate_limits: {
              plan_type: "pro",
              primary: {
                used_percent: 21,
                resets_at: 1779550026,
                window_minutes: 300,
              },
              secondary: {
                used_percent: 34,
                resets_at: 1780118811,
                window_minutes: 10080,
              },
            },
            info: { model_context_window: 262144 },
          },
        })}\n`,
      );

      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl: fetchJson({}),
      });
      const result = await service.fetchUsage("req-2", "provider_usage_get", "codex");

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        planType: "pro",
        shortUsedPercent: 21,
        weeklyUsedPercent: 34,
        sessionTokens: 262144,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("classifies a single local Codex primary window from window_minutes", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-"));
    try {
      const sessionDir = join(home, ".codex", "sessions", "2026", "07", "20");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "rollout-live-shape.jsonl"),
        `${JSON.stringify({
          payload: {
            type: "token_count",
            rate_limits: {
              plan_type: "pro",
              primary: {
                used_percent: 80,
                resets_at: 1784951882,
                window_minutes: 10080,
              },
              secondary: null,
            },
          },
        })}\n`,
      );

      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl: fetchJson({}),
      });
      const result = await service.fetchUsage("req-live", "provider_usage_get", "codex");

      expect(result.data).toMatchObject({
        shortUsedPercent: null,
        weeklyUsedPercent: 80,
        weeklyResetAt: 1784951882,
        quotas: [
          expect.objectContaining({
            id: "codex:7d",
            label: "7일",
            remainingPercent: 20,
          }),
        ],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("normalizes Gemini Code Assist quota buckets", () => {
    const limits = geminiLimitsFromQuotaResponse(
      {
        buckets: [
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: 0.75,
            remainingAmount: 150,
            tokenType: "REQUESTS",
            resetTime: "2026-05-24T00:00:00Z",
          },
        ],
      },
      { currentTier: { name: "free" } },
    );

    expect(limits).toMatchObject({
      status: "auto",
      planType: "free",
      quotas: [
        {
          id: "gemini:gemini-2.5-pro",
          label: "Gemini Pro",
          used: 50,
          remaining: 150,
          limit: 200,
          usedPercent: 25,
          remainingPercent: 75,
          unit: "requests",
        },
      ],
    });
  });
});
