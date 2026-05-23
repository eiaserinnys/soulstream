import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ProviderUsageService,
  geminiLimitsFromQuotaResponse,
} from "../../src/auth/provider_usage.js";

function fetchJson(payload: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

describe("ProviderUsageService", () => {
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
