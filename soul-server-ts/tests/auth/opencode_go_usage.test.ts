import { describe, expect, it, vi } from "vitest";
import {
  OPENCODE_GO_USAGE_URL,
  collectOpencodeGoUsage,
} from "../../src/auth/opencode_go_usage.js";
import { ProviderUsageService } from "../../src/auth/provider_usage.js";
import { ProviderUsageCommands } from "../../src/upstream/provider_usage_commands.js";

const SAMPLE = {
  usage: {
    rolling: { status: "ok", percent: 2, resetsAt: "2026-11-07T09:43:01.000Z" },
    weekly: { status: "ok", percent: 18, resetsAt: "2026-11-09T00:00:00.000Z" },
    monthly: { status: "ok", percent: 9, resetsAt: "2026-12-06T13:17:36.000Z" },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("OpenCode Go usage collector", () => {
  it("does not call the network without an API key", async () => {
    const fetchImpl = vi.fn();

    const unset = await collectOpencodeGoUsage({ fetchImpl } as unknown as {
      fetchImpl: typeof fetch;
    }, signal());
    const empty = await collectOpencodeGoUsage({ apiKey: "", fetchImpl } as unknown as {
      apiKey: string;
      fetchImpl: typeof fetch;
    }, signal());

    expect(unset).toMatchObject({ status: "not_configured", quotas: [], weeklyUsedPercent: null });
    expect(empty).toMatchObject({ status: "not_configured", quotas: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps the rolling, weekly and monthly windows from the measured response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SAMPLE));

    const limits = await collectOpencodeGoUsage({ apiKey: "go-key", fetchImpl }, signal());

    expect(limits).toMatchObject({
      status: "auto",
      source: OPENCODE_GO_USAGE_URL,
      sourceKind: "remote",
      planType: "구독",
      weeklyUsedPercent: 18,
      weeklyResetAt: Date.parse("2026-11-09T00:00:00.000Z") / 1000,
      shortUsedPercent: 2,
      shortResetAt: Date.parse("2026-11-07T09:43:01.000Z") / 1000,
      shortWindowMinutes: 300,
      weeklyTokens: null,
      monthlyTokens: null,
      sessionTokens: null,
    });
    expect(limits.observedAt).toEqual(expect.any(String));
    expect(limits.quotas).toEqual([
      expect.objectContaining({
        id: "opencode_go:rolling",
        label: "5시간",
        window: "5h",
        unit: null,
        used: null,
        remaining: null,
        limit: null,
        model: null,
        usedPercent: 2,
        remainingPercent: 98,
        resetAt: Date.parse("2026-11-07T09:43:01.000Z") / 1000,
        source: OPENCODE_GO_USAGE_URL,
        purpose: "execution",
      }),
      expect.objectContaining({
        id: "opencode_go:weekly",
        label: "7일",
        window: "7d",
        usedPercent: 18,
        remainingPercent: 82,
        resetAt: Date.parse("2026-11-09T00:00:00.000Z") / 1000,
      }),
      expect.objectContaining({
        id: "opencode_go:monthly",
        label: "월",
        window: "monthly",
        usedPercent: 9,
        remainingPercent: 91,
        resetAt: Date.parse("2026-12-06T13:17:36.000Z") / 1000,
      }),
    ]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENCODE_GO_USAGE_URL);
    expect(init.headers).toMatchObject({ Authorization: "Bearer go-key" });
  });

  it("reports a rate-limited window as fully used", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      usage: {
        ...SAMPLE.usage,
        rolling: { status: "rate-limited", percent: 40, resetsAt: "2026-11-07T09:43:01.000Z" },
      },
    }));

    const limits = await collectOpencodeGoUsage({ apiKey: "go-key", fetchImpl }, signal());

    expect(limits.quotas[0]).toMatchObject({ id: "opencode_go:rolling", usedPercent: 100, remainingPercent: 0 });
    expect(limits.shortUsedPercent).toBe(100);
  });

  it.each([
    ["missing window", { usage: { weekly: SAMPLE.usage.weekly, monthly: SAMPLE.usage.monthly } }],
    ["unknown status", { usage: { ...SAMPLE.usage, weekly: { ...SAMPLE.usage.weekly, status: "paused" } } }],
    ["negative percent", { usage: { ...SAMPLE.usage, weekly: { ...SAMPLE.usage.weekly, percent: -1 } } }],
    ["non numeric percent", { usage: { ...SAMPLE.usage, weekly: { ...SAMPLE.usage.weekly, percent: "18" } } }],
    ["unparsable reset", { usage: { ...SAMPLE.usage, weekly: { ...SAMPLE.usage.weekly, resetsAt: "soon" } } }],
  ])("returns an error instead of partial numbers for %s", async (_label, body) => {
    const limits = await collectOpencodeGoUsage({
      apiKey: "go-key",
      fetchImpl: async () => jsonResponse(body),
    }, signal());

    expect(limits).toMatchObject({
      status: "error",
      error: "Invalid OpenCode Go usage response",
      quotas: [],
      weeklyUsedPercent: null,
      shortUsedPercent: null,
    });
  });

  it("keeps the key out of the error text for every failure path", async () => {
    const key = "secret-key-abc";
    const cases: [() => Promise<Response>, string][] = [
      [async () => jsonResponse({}, 401), "OpenCode Go 키 오류"],
      [async () => jsonResponse({}, 403), "OpenCode Go 구독 없음"],
      [async () => jsonResponse({}, 500), "OpenCode Go usage HTTP 500"],
      [async () => { throw new TypeError("network down"); }, "OpenCode Go usage request failed"],
      [async () => new Response("not json", { status: 200 }), "Invalid OpenCode Go usage response"],
    ];

    for (const [fetchImpl, message] of cases) {
      const limits = await collectOpencodeGoUsage({
        apiKey: key,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }, signal());
      expect(limits).toMatchObject({ status: "error", error: message, quotas: [] });
      expect(limits.error).not.toContain(key);
    }
  });
});

describe("OpenCode Go provider wiring", () => {
  it("dispatches the collector through provider_usage_get and the full snapshot", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SAMPLE));
    const service = new ProviderUsageService({ opencodeGo: { apiKey: "go-key", fetchImpl } });

    const response = await new ProviderUsageCommands({ providerUsage: service }).handle({
      type: "provider_usage_get",
      requestId: "req",
      provider: "opencode_go",
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        status: "auto",
        quotas: [
          expect.objectContaining({ window: "5h" }),
          expect.objectContaining({ window: "7d" }),
          expect.objectContaining({ window: "monthly" }),
        ],
      },
    });

    const snapshot = await service.fetchSnapshot();
    expect(Object.keys(snapshot.providers)).toEqual(["claude", "codex", "antigravity", "opencode_go"]);
    expect(snapshot.providers.opencode_go.status).toBe("auto");
  });

  it("reports not_configured through the service when the node has no key", async () => {
    const fetchImpl = vi.fn();
    const service = new ProviderUsageService({ opencodeGo: { fetchImpl }, homeDir: "/nonexistent-go-fixture-home" });

    expect(await service.fetchProvider("opencode_go")).toMatchObject({ status: "not_configured", quotas: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects providers outside the supported list", async () => {
    const commands = new ProviderUsageCommands({
      providerUsage: new ProviderUsageService({ homeDir: "/nonexistent-go-fixture-home" }),
    });
    await expect(commands.handle({ type: "provider_usage_get", provider: "gemini" }))
      .rejects.toThrow("provider must be one of: claude, codex, antigravity, opencode_go");
  });
});
