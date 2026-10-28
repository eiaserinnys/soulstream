import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import {
  ProviderUsageService,
  claudeLimitsFromUsageResponse,
  codexLimitsFromUsageResponse,
} from "../../src/auth/provider_usage.js";
import {
  readProviderUsageObservation,
  resetProviderUsageObservationMemo,
} from "../../src/auth/provider_usage_observation.js";
import type { ClaudeAuthCommandHandler } from "../../src/auth/claude_auth.js";
import {
  createProviderUsageDeadline,
  providerUsageEndpoint,
} from "../../src/auth/provider_usage_telemetry.js";
import { ClaudeAccountService } from "../../src/claude_accounts/index.js";

function fetchJson(payload: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

interface CapturedLog {
  level: "debug" | "info" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

function captureLogger(): {
  logger: Pick<Logger, "debug" | "info" | "warn">;
  entries: CapturedLog[];
} {
  const entries: CapturedLog[] = [];
  const logger = {
    debug(fields: Record<string, unknown>, message: string) {
      entries.push({ level: "debug", fields, message });
    },
    info(fields: Record<string, unknown>, message: string) {
      entries.push({ level: "info", fields, message });
    },
    warn(fields: Record<string, unknown>, message: string) {
      entries.push({ level: "warn", fields, message });
    },
  } as unknown as Pick<Logger, "debug" | "info" | "warn">;
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
  it("updates the process observation memo through provider_usage_get", async () => {
    resetProviderUsageObservationMemo();
    const claudeAuth = {
      fetchUsage: vi.fn(async () => ({
        success: true,
        data: {
          five_hour: { utilization: 20, resets_at: "2026-10-06T01:00:00.000Z" },
          seven_day: { utilization: 35, resets_at: "2026-10-07T00:00:00.000Z" },
        },
      })),
    } as unknown as ClaudeAuthCommandHandler;
    const service = new ProviderUsageService({ claudeAuth });

    const response = await service.fetchUsage("req-usage", "provider_usage_get", "claude");

    expect(response.success).toBe(true);
    expect(readProviderUsageObservation("claude")?.result).toMatchObject({
      status: "auto",
      weeklyUsedPercent: 35,
      shortUsedPercent: 20,
    });
    expect(readProviderUsageObservation("claude")?.observed_at).toBeTruthy();
  });

  it("timestamps remote quota observations and marks code review separately from execution", () => {
    const before = Date.now();
    const limits = codexLimitsFromUsageResponse({ rate_limit: { primary_window: { used_percent: 85, limit_window_seconds: 18000 } }, code_review_rate_limit: { primary_window: { used_percent: 100 } } });
    expect(limits).toMatchObject({ sourceKind: "remote", source: "codex-usage-api" });
    expect(Date.parse(limits.observedAt!)).toBeGreaterThanOrEqual(before);
    expect(limits.quotas.map(q => q.purpose)).toEqual(["execution", "code_review"]);
    expect(claudeLimitsFromUsageResponse({ five_hour: { utilization: 10 } })).toMatchObject({ sourceKind: "remote", quotas: [{ purpose: "execution" }] });
  });
  it("reduces telemetry endpoints to host and path", () => {
    expect(
      providerUsageEndpoint(
        "https://user:password@example.com/provider/usage?access_token=secret#fragment",
      ),
    ).toBe("example.com/provider/usage");
  });

  it("records scheduled and actual deadline firing time without request data", async () => {
    const { logger, entries } = captureLogger();
    const deadline = createProviderUsageDeadline(logger, {
      provider: "codex",
      endpoint: "chatgpt.com/backend-api/wham/usage",
      timeoutMs: 5,
      scope: "provider",
    });

    await new Promise<void>((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Provider usage timeout fired",
        fields: expect.objectContaining({
          provider: "codex",
          endpoint: "chatgpt.com/backend-api/wham/usage",
          result: "timeout_fired",
          timeoutScope: "provider",
          timeoutMs: 5,
          scheduledAbortAtMs: expect.any(Number),
          actualAbortAtMs: expect.any(Number),
          abortDelayMs: expect.any(Number),
        }),
      }),
    );
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
            entry.level === "info"
            && entry.fields.provider === "codex"
            && entry.fields.endpoint === "chatgpt.com/backend-api/wham/usage"
            && entry.fields.result === "started"
            && entry.fields.durationMs === 0,
        ),
      ).toBe(true);
      expect(
        entries.some(
          (entry) =>
            entry.level === "warn"
            && entry.fields.provider === "codex"
            && entry.fields.endpoint === "chatgpt.com/backend-api/wham/usage"
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

  it("gives a timed-out wham request and each recovery candidate an independent budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-candidate-budget-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: "codex-access" } }),
      );
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/backend-api/wham/usage")) {
          const signal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(signal.reason ?? new Error("aborted")),
              { once: true },
            );
          });
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 19,
                reset_at: 1779550026,
                limit_window_seconds: 18000,
              },
            },
          }),
          text: async () => "",
        } as Response;
      }) as unknown as typeof fetch;
      const { logger, entries } = captureLogger();
      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl,
        logger,
        requestTimeoutMs: 100,
        codexPrimaryRequestTimeoutMs: 20,
        codexRecoveryRequestTimeoutMs: 20,
      });

      const result = await service.fetchUsage("req-candidate-budget", "provider_usage_get", "codex");

      expect(result).toMatchObject({ success: true, data: { status: "auto" } });
      expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/codex/usage",
      ]);
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Provider usage summary",
          fields: expect.objectContaining({
            provider: "codex",
            result: "success",
            attempts: [
              expect.objectContaining({ result: "timeout", budgetMs: 20 }),
              expect.objectContaining({ result: "success", budgetMs: 20 }),
            ],
          }),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("classifies Cloudflare challenges without reading or logging the response body", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-cloudflare-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "codex-access",
            refresh_token: "codex-refresh-secret",
          },
        }),
      );
      const responseText = vi.fn(async () => "Enable JavaScript and cookies to continue");
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ "cf-mitigated": "challenge", server: "cloudflare" }),
        json: async () => ({}),
        text: responseText,
      })) as unknown as typeof fetch;
      const { logger, entries } = captureLogger();
      const service = new ProviderUsageService({
        homeDir: home,
        fetchImpl,
        logger,
        codexRuntimeLimitsImpl: () => codexLimitsFromUsageResponse({}),
      });

      await service.fetchUsage("req-cloudflare", "provider_usage_get", "codex");

      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({
            provider: "codex",
            result: "cloudflare_challenge",
            status: 403,
          }),
        }),
      );
      expect(responseText).not.toHaveBeenCalled();
      expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/codex/usage",
        "https://chatgpt.com/api/codex/usage",
      ]);
      expect(entries).toContainEqual(
        expect.objectContaining({
          message: "Provider usage summary",
          fields: expect.objectContaining({
            timeoutMs: 14_000,
            attempts: [
              expect.objectContaining({ budgetMs: 12_000 }),
              expect.objectContaining({ budgetMs: 500 }),
              expect.objectContaining({ budgetMs: 500 }),
              expect.objectContaining({ endpoint: "filesystem/.codex/sessions" }),
            ],
          }),
        }),
      );
      expect(JSON.stringify(entries)).not.toContain("Enable JavaScript");
      expect(JSON.stringify(entries)).not.toContain("codex-refresh-secret");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refreshes Codex OAuth only for an actual authorization HTTP failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-auth-refresh-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "expired-access",
            refresh_token: "refresh-secret",
          },
        }),
      );
      let refreshed = false;
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        if (String(url) === "https://auth.openai.com/oauth/token") {
          refreshed = true;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ access_token: "fresh-access" }),
            text: async () => "",
          } as Response;
        }
        if (!refreshed) {
          return {
            ok: false,
            status: 401,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({}),
            text: async () => "unauthorized",
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 19,
                reset_at: 1779550026,
                limit_window_seconds: 18000,
              },
            },
          }),
          text: async () => "",
        } as Response;
      }) as unknown as typeof fetch;
      const service = new ProviderUsageService({ homeDir: home, fetchImpl });

      const result = await service.fetchUsage("req-refresh", "provider_usage_get", "codex");

      expect(result).toMatchObject({ success: true, data: { status: "auto" } });
      expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/codex/usage",
        "https://chatgpt.com/api/codex/usage",
        "https://auth.openai.com/oauth/token",
        "https://chatgpt.com/backend-api/wham/usage",
      ]);
      expect(vi.mocked(fetchImpl).mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer fresh-access" }),
        }),
      );
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
            antigravity: { status: "not_configured" },
          },
        },
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({
            provider: "codex",
            endpoint: "chatgpt.com/backend-api/wham/usage",
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

  it("logs local Codex rollout scan files, stats, bytes, reads, and duration", async () => {
    const home = await mkdtemp(join(tmpdir(), "provider-usage-scan-metrics-"));
    try {
      const sessionDir = join(home, ".codex", "sessions", "2026", "08", "13");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "rollout-metrics.jsonl"),
        `${JSON.stringify({
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 1, window_minutes: 300 },
            },
          },
        })}\n`,
      );
      const { logger, entries } = captureLogger();
      const service = new ProviderUsageService({ homeDir: home, logger });

      await service.fetchUsage("req-scan-metrics", "provider_usage_get", "codex");

      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Provider usage local rollout scan finished",
          fields: expect.objectContaining({
            provider: "codex",
            candidateFiles: 1,
            filesVisited: expect.any(Number),
            statCount: expect.any(Number),
            candidateBytes: expect.any(Number),
            readFiles: 1,
            readBytes: expect.any(Number),
            durationMs: expect.any(Number),
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
        "https://chatgpt.com/backend-api/wham/usage",
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
        sourceKind: "rollout",
        observedAt: null,
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
          timestamp: "2026-07-20T12:00:00.000Z",
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
        sourceKind: "rollout",
        observedAt: "2026-07-20T12:00:00.000Z",
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

  it("projects Claude account pool limits, fable_pool, per-scope best quotas, and partial deadline results using real ClaudeAccountService", async () => {
    resetProviderUsageObservationMemo();
    const root = await mkdtemp(join(tmpdir(), "provider-claude-pool-"));
    const accountsDir = join(root, "claude-accounts");
    const homeDir = join(root, "home");
    await mkdir(homeDir, { recursive: true });

    const accGeneral = "11111111-1111-4111-8111-111111111111";
    const accFable = "22222222-2222-4222-8222-222222222222";
    let hangFable = false;
    let generalFiveHour = 25;
    let nowMs = Date.parse("2026-10-28T01:00:00.000Z");

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token === "tok-general") {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: generalFiveHour, resets_at: "2026-10-28T06:00:00.000Z" },
            seven_day: { utilization: 40, resets_at: "2026-11-04T00:00:00.000Z" },
            seven_day_fable: { utilization: 85, resets_at: "2026-11-04T00:00:00.000Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (hangFable) {
        return await new Promise<Response>(() => {
          // Exceeds provider deadline
        });
      }
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 30, resets_at: "2026-10-28T06:00:00.000Z" },
          seven_day: { utilization: 45, resets_at: "2026-11-04T00:00:00.000Z" },
          limits: [
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 15,
              resets_at: "2026-11-03T00:00:00.000Z",
              scope: { model: { id: null, display_name: "Fable" }, surface: null },
              is_active: false,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const claudeAccounts = new ClaudeAccountService({
        accountsDir,
        homeDir,
        now: () => nowMs,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const p1 = await claudeAccounts.createPendingDir("login-1");
      await writeFile(
        join(p1, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "tok-general",
            refreshToken: "ref-1",
            expiresAt: nowMs + 7200_000,
          },
        }),
      );
      await claudeAccounts.registerFromPending({
        loginId: "login-1",
        id: accGeneral,
        email: "general@example.com",
        plan: "max",
      });

      const p2 = await claudeAccounts.createPendingDir("login-2");
      await writeFile(
        join(p2, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "tok-fable",
            refreshToken: "ref-2",
            expiresAt: nowMs + 7200_000,
          },
        }),
      );
      await claudeAccounts.registerFromPending({
        loginId: "login-2",
        id: accFable,
        email: "fable@example.com",
        plan: "max",
      });

      const service = new ProviderUsageService({
        claudeAccounts,
        requestTimeoutMs: 40,
      });
      const response = await service.fetchUsage("req-pool", "provider_usage_get", "claude");

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({
        status: "auto",
        mode: "pool",
        planType: "max",
        shortUsedPercent: 25,
        shortResetAt: Math.floor(Date.parse("2026-10-28T06:00:00.000Z") / 1000),
        weeklyUsedPercent: 40,
        weeklyResetAt: Math.floor(Date.parse("2026-11-04T00:00:00.000Z") / 1000),
        pool: {
          total_count: 2,
          available_count: 2,
          best_weekly_remaining_percent: 60,
          best_weekly_resets_at: "2026-11-04T00:00:00.000Z",
          earliest_available_at: null,
        },
        fable_pool: {
          total_count: 2,
          available_count: 2,
          best_weekly_remaining_percent: 55,
          best_weekly_resets_at: "2026-11-04T00:00:00.000Z",
          earliest_available_at: null,
        },
        quotas: [
          expect.objectContaining({
            id: "claude:five_hour",
            usedPercent: 25,
            remainingPercent: 75,
            resetAt: Math.floor(Date.parse("2026-10-28T06:00:00.000Z") / 1000),
          }),
          expect.objectContaining({
            id: "claude:seven_day",
            usedPercent: 40,
            remainingPercent: 60,
            resetAt: Math.floor(Date.parse("2026-11-04T00:00:00.000Z") / 1000),
          }),
          expect.objectContaining({
            id: "claude:weekly_scoped:fable",
            usedPercent: 15,
            remainingPercent: 85,
            resetAt: Math.floor(Date.parse("2026-11-03T00:00:00.000Z") / 1000),
          }),
        ],
      });

      // Deadline partial result: advance past 5-minute TTL; accGeneral finishes immediately (with updated 10%), while accFable hangs past requestTimeoutMs (40ms).
      // ProviderUsageService must NOT fail into emptyLimits("error"), and must return both accounts (accGeneral fresh, accFable stale with previous values).
      nowMs += 6 * 60_000;
      generalFiveHour = 10;
      hangFable = true;
      const partialRes = await service.fetchUsage(
        "req-pool-deadline",
        "provider_usage_refresh",
        "claude",
      );
      expect(partialRes.success).toBe(true);
      expect(partialRes.data?.status).toBe("auto");
      expect(partialRes.data?.mode).toBe("pool");
      expect(partialRes.data?.accounts).toHaveLength(2);
      const generalAfter = partialRes.data?.accounts?.find((a) => a.id === accGeneral);
      const fableAfter = partialRes.data?.accounts?.find((a) => a.id === accFable);
      expect(generalAfter?.stale).toBe(false);
      expect(generalAfter?.usage.five_hour?.used_percent).toBe(10);
      expect(fableAfter?.stale).toBe(true);
      expect(fableAfter?.usage.fable_weekly?.used_percent).toBe(15);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps mode=pool even when 0 accounts exist in the pool, and preserves exact legacy response when pool flag is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-claude-empty-pool-"));
    try {
      const emptyClaudeAccounts = new ClaudeAccountService({
        accountsDir: join(root, "claude-accounts"),
        homeDir: join(root, "home"),
        fetchImpl: vi.fn() as unknown as typeof fetch,
      });
      const poolService = new ProviderUsageService({ claudeAccounts: emptyClaudeAccounts });
      const poolRes = await poolService.fetchUsage("req-empty-pool", "provider_usage_get", "claude");
      expect(poolRes.data).toMatchObject({
        status: "not_configured",
        mode: "pool",
        accounts: [],
        pool: { total_count: 0, available_count: 0 },
      });

      const legacyUnconfigured = new ProviderUsageService({});
      const legacyUnconfiguredRes = await legacyUnconfigured.fetchUsage(
        "req-legacy-unconfigured",
        "provider_usage_get",
        "claude",
      );
      expect(legacyUnconfiguredRes.data).toEqual({
        status: "not_configured",
        source: "",
        sourceKind: "unknown",
        observedAt: null,
        planType: null,
        shortUsedPercent: null,
        shortWindowMinutes: null,
        shortResetAt: null,
        weeklyUsedPercent: null,
        weeklyResetAt: null,
        sessionTokens: null,
        weeklyTokens: null,
        monthlyTokens: null,
        quotas: [],
      });
      expect("mode" in (legacyUnconfiguredRes.data as Record<string, unknown>)).toBe(false);

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-28T01:00:00.000Z"));
      const claudeAuth: ClaudeAuthCommandHandler = {
        getStatus: vi.fn(),
        setToken: vi.fn(),
        deleteToken: vi.fn(),
        fetchProfile: vi.fn(),
        fetchUsage: vi.fn(async () => ({
          type: "provider_usage_get",
          requestId: "",
          success: true,
          data: {
            five_hour: { utilization: 22, resets_at: "2026-04-14T15:00:00Z" },
            seven_day: { utilization: 44, resets_at: "2026-04-20T00:00:00Z" },
          },
        })),
      };
      const legacyConfigured = new ProviderUsageService({ claudeAuth });
      const legacyConfiguredRes = await legacyConfigured.fetchUsage(
        "req-legacy-configured",
        "provider_usage_get",
        "claude",
      );
      // Fixtures below are derived from the legacy e0382faf response path.
      const expectedLegacy = {
        status: "auto",
        source: "https://api.anthropic.com/api/oauth/usage",
        sourceKind: "remote",
        observedAt: "2026-10-28T01:00:00.000Z",
        weeklyTokens: null,
        monthlyTokens: null,
        sessionTokens: null,
        weeklyUsedPercent: 44,
        weeklyResetAt: 1776643200,
        shortUsedPercent: 22,
        shortWindowMinutes: 300,
        shortResetAt: 1776178800,
        planType: null,
        quotas: [
          {
            id: "claude:five_hour", label: "5시간", window: "5h", unit: "percent",
            used: null, remaining: null, limit: null, usedPercent: 22, remainingPercent: 78,
            resetAt: 1776178800, model: null, source: "https://api.anthropic.com/api/oauth/usage",
            purpose: "execution",
          },
          {
            id: "claude:seven_day", label: "7일", window: "7d", unit: "percent",
            used: null, remaining: null, limit: null, usedPercent: 44, remainingPercent: 56,
            resetAt: 1776643200, model: null, source: "https://api.anthropic.com/api/oauth/usage",
            purpose: "execution",
          },
        ],
      };
      expect(legacyConfiguredRes.data).toEqual({
        ...expectedLegacy,
        observedAt: expect.any(String),
      });
      expect("mode" in (legacyConfiguredRes.data as Record<string, unknown>)).toBe(false);
      expect(legacyConfiguredRes).toEqual({
        type: "provider_usage_get", requestId: "req-legacy-configured", success: true,
        data: expectedLegacy,
      });

      const noToken = new ProviderUsageService({
        claudeAuth: { ...claudeAuth, fetchUsage: vi.fn(async () => ({
          type: "provider_usage_get", requestId: "", success: false, error: "no token",
        })) },
      });
      expect(await noToken.fetchUsage("req-legacy-no-token", "provider_usage_get", "claude")).toEqual({
        type: "provider_usage_get", requestId: "req-legacy-no-token", success: true,
        data: {
          status: "not_configured", source: "", sourceKind: "unknown", observedAt: null,
          weeklyTokens: null, monthlyTokens: null, sessionTokens: null,
          weeklyUsedPercent: null, weeklyResetAt: null, shortUsedPercent: null,
          shortWindowMinutes: null, shortResetAt: null, planType: null, quotas: [],
        },
      });

      const transientError = new ProviderUsageService({
        claudeAuth: { ...claudeAuth, fetchUsage: vi.fn(async () => ({
          type: "provider_usage_get", requestId: "", success: false, error: "upstream unavailable",
        })) },
      });
      expect(await transientError.fetchUsage("req-legacy-error", "provider_usage_get", "claude")).toEqual({
        type: "provider_usage_get", requestId: "req-legacy-error", success: true,
        data: {
          status: "error", source: "", sourceKind: "unknown", observedAt: null,
          weeklyTokens: null, monthlyTokens: null, sessionTokens: null,
          weeklyUsedPercent: null, weeklyResetAt: null, shortUsedPercent: null,
          shortWindowMinutes: null, shortResetAt: null, planType: null, quotas: [],
          error: "upstream unavailable",
        },
      });
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
