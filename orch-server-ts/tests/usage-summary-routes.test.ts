import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  usageSummaryRouteAuthRequirements,
} from "../src/index.js";

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
    const summary = {
      generatedAt: "2026-07-20T10:00:01.000Z",
      collectedAt: "2026-07-20T10:00:00.000Z",
      nodes: [{
        nodeId: "eiaserinnys",
        fetchedAt: "2026-07-20T10:00:00.000Z",
        stale: false,
        staleSince: null,
        providers: { claude: null, codex: null, gemini: null },
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
    });
    await app.close();
  });
});
