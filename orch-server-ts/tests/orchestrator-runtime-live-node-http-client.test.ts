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

type TestWebSocket = {
  send: (data: string) => void;
  terminate: () => void;
};

type WebSocketInjectableApp = {
  injectWS: (
    path: string,
    upgradeContext?: { headers?: Record<string, string> },
  ) => Promise<TestWebSocket>;
};

describe("orchestrator runtime live node HTTP client", () => {
  it("uses a live board-yjs host HTTP client by default", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const runtime = createOrchestratorRuntimeComposition({
      config,
      nowMs: () => 1_700_000_000_000,
      nodeHttpFetch: fetch,
      sseReplayOnlyForTests: true,
    });

    await runtime.app.ready();
    const ws = await (runtime.app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
      { headers: { authorization: "Bearer test-token" } },
    );
    ws.send(
      JSON.stringify({
        type: "node_register",
        node_id: "board-host",
        host: "127.0.0.1",
        port: 4105,
        agents: [],
        capabilities: { board_yjs_host: true },
      }),
    );
    await waitFor(() => runtime.registry.getConnectedNode("board-host") !== undefined);

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      headers: { authorization: "Bearer test-token" },
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4105/api/internal/board-yjs/update",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ update: "payload" }),
      }),
    );

    ws.terminate();
    await runtime.app.close();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
