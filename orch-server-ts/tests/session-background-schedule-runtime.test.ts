import { describe, expect, it, vi } from "vitest";

import {
  createOrchestratorRuntimeComposition,
  parseOrchServerConfig,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session background task/schedule runtime opt-in", () => {
  it("keeps routes off in runtime composition unless explicitly enabled", async () => {
    const disabled = createOrchestratorRuntimeComposition({
      config,
      loadSessionSnapshot: async () => ({ sessions: [] }),
      boardYjsHostHttpClient: vi.fn(),
    });

    const disabledResponse = await disabled.app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/background-tasks",
    });
    expect(disabledResponse.statusCode).toBe(404);
    expect(disabledResponse.json()).not.toMatchObject({
      error: { code: "SESSION_OWNER_MISSING" },
    });
    expect(disabled.routeOptions.sessionBackgroundScheduleRoutes).toBeUndefined();
    await disabled.app.close();

    const enabled = createOrchestratorRuntimeComposition({
      config,
      enableSessionBackgroundScheduleRoutes: true,
      loadSessionSnapshot: async () => ({ sessions: [] }),
      boardYjsHostHttpClient: vi.fn(),
    });

    const enabledResponse = await enabled.app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/background-tasks",
    });
    expect(enabledResponse.statusCode).toBe(404);
    expect(enabledResponse.json()).toMatchObject({
      error: { code: "SESSION_OWNER_MISSING" },
    });
    expect(enabled.routeOptions.sessionBackgroundScheduleRoutes).toBeDefined();
    await enabled.app.close();
  });
});
