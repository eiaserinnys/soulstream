import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  usageSummaryRouteAuthRequirements,
} from "../src/index.js";
import type { UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("usage summary route", () => {
  it("is additive and disabled until explicitly registered", async () => {
    const app = createApp({ config });
    expect(await app.inject({ method: "GET", url: "/api/usage/summary" }))
      .toMatchObject({ statusCode: 404 });
    await app.close();
  });

  it("returns the cached widget contract", async () => {
    const summary: UsageSummarySnapshot = {
      generatedAt: "2026-07-20T10:00:01.000Z",
      collectedAt: "2026-07-20T10:00:00.000Z",
      nodes: [{
        nodeId: "eiaserinnys",
        fetchedAt: "2026-07-20T10:00:00.000Z",
        stale: false,
        staleSince: null,
        providers: { claude: null, codex: null, antigravity: null },
      }],
    };
    const service = { getSummary: vi.fn(() => summary) };
    const app = createApp({ config, usageSummaryRoutes: { service } });

    const response = await app.inject({ method: "GET", url: "/api/usage/summary" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(summary);
    expect(service.getSummary).toHaveBeenCalledOnce();
    expect(usageSummaryRouteAuthRequirements).toEqual({
      "GET /api/usage/summary": true,
      "GET /api/usage/stream": true,
    });
    await app.close();
  });

  it("streams the current usage snapshot as an authenticated usage_summary event", async () => {
    const summary: UsageSummarySnapshot = {
      generatedAt: "2026-10-28T04:00:00.000Z",
      collectedAt: "2026-10-28T04:00:00.000Z",
      nodes: [{
        nodeId: "pool-node",
        fetchedAt: "2026-10-28T04:00:00.000Z",
        stale: false,
        staleSince: null,
        providers: {
          claude: {
            status: "auto",
            weeklyRemainingPercent: null,
            weeklyResetAt: null,
            shortRemainingPercent: null,
            shortResetAt: null,
            quotas: [],
            mode: "pool",
            accounts: [],
            pool: null,
            fable_pool: null,
          },
          codex: null,
          antigravity: null,
        },
      }],
    };
    const service = { getSummary: vi.fn(() => summary), subscribe: vi.fn(() => () => undefined) };
    const app = createApp({ config, usageSummaryRoutes: { service, replayOnlyForTests: true } });

    const response = await app.inject({ method: "GET", url: "/api/usage/stream" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: usage_summary");
    expect(response.body).toContain('"type":"usage_summary"');
    expect(response.body).toContain('"fable_pool":null');
    expect(service.getSummary).toHaveBeenCalledOnce();
    expect(usageSummaryRouteAuthRequirements).toEqual({
      "GET /api/usage/summary": true,
      "GET /api/usage/stream": true,
    });
    await app.close();
  });
});
