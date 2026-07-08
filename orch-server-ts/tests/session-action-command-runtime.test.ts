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

describe("session action command runtime opt-in", () => {
  it("keeps routes off in runtime composition unless explicitly enabled", async () => {
    const disabled = createOrchestratorRuntimeComposition({
      config,
      loadSessionSnapshot: async () => ({ sessions: [] }),
      loadTaskSnapshot: async () => ({ tasks: [] }),
      boardYjsHostHttpClient: vi.fn(),
    });

    const disabledResponse = await disabled.app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/intervene",
      payload: { text: "hello" },
    });
    expect(disabledResponse.statusCode).toBe(404);
    expect(disabledResponse.json()).not.toMatchObject({
      error: { code: "SESSION_OWNER_MISSING" },
    });
    expect(disabled.routeOptions.sessionActionCommandRoutes).toBeUndefined();
    await disabled.app.close();

    const enabled = createOrchestratorRuntimeComposition({
      config,
      enableSessionActionCommandRoutes: true,
      loadSessionSnapshot: async () => ({ sessions: [] }),
      loadTaskSnapshot: async () => ({ tasks: [] }),
      boardYjsHostHttpClient: vi.fn(),
    });

    const enabledResponse = await enabled.app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/intervene",
      payload: { text: "hello" },
    });
    expect(enabledResponse.statusCode).toBe(404);
    expect(enabledResponse.json()).toMatchObject({
      error: { code: "SESSION_OWNER_MISSING" },
    });
    expect(enabled.routeOptions.sessionActionCommandRoutes).toBeDefined();
    await enabled.app.close();
  });
});
