import { describe, expect, it } from "vitest";

import {
  NodeCredentialStore,
  NodePairingService,
  createApp,
  nodePairingRouteAuthRequirements,
  parseOrchServerConfig,
} from "../src/index.js";
import { InMemoryNodeCredentialRepository } from "./node-credentials-test-support.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

async function createHarness() {
  const repository = new InMemoryNodeCredentialRepository();
  const store = new NodeCredentialStore({ repository });
  await store.initialize();
  const connected = new Set<string>();
  const stored = new Set<string>();
  let now = 1_790_000_000_000;
  const service = new NodePairingService({
    store,
    isNodeConnected: nodeId => connected.has(nodeId),
    hasStoredNode: nodeId => stored.has(nodeId),
    now: () => now,
  });
  const app = createApp({ config, nodePairRoutes: { service } });
  return {
    app,
    service,
    store,
    repository,
    connected,
    stored,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("node pairing HTTP routes", () => {
  it("keeps the pairing routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const url of ["/api/node-pair/start", "/api/node-pair/poll"]) {
      expect(await app.inject({ method: "POST", url, payload: {} }))
        .toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("declares both pairing routes public", () => {
    expect(nodePairingRouteAuthRequirements).toEqual({
      "POST /api/node-pair/start": false,
      "POST /api/node-pair/poll": false,
    });
  });

  it("serves the pairing flow without an authorization header", async () => {
    const harness = await createHarness();

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/start",
      payload: { node_id: "node-route", company_pc: true },
    });
    expect(started.statusCode).toBe(200);
    const startBody = started.json<{ device_code: string; user_code: string }>();

    const pending = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/poll",
      payload: { device_code: startBody.device_code },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });

    const approvedCredential = await harness.service.approve(startBody.user_code);

    const handedOut = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/poll",
      payload: { device_code: startBody.device_code },
    });
    expect(handedOut.statusCode).toBe(200);
    const approved = handedOut.json<{
      status: string;
      node_id: string;
      company_pc: boolean;
      token: string;
    }>();
    expect(approved).toMatchObject({
      status: "approved",
      node_id: "node-route",
      company_pc: true,
    });
    expect(harness.store.resolve(approved.token)).toEqual(approvedCredential);

    const consumed = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/poll",
      payload: { device_code: startBody.device_code },
    });
    expect(consumed.statusCode).toBe(404);

    await harness.app.close();
  });

  it("maps invalid input to 400 and the pending limit to 429", async () => {
    const harness = await createHarness();

    const invalid = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/start",
      payload: { node_id: "Node-Route", company_pc: true },
    });
    expect(invalid.statusCode).toBe(400);

    const missingCompanyPc = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/start",
      payload: { node_id: "node-route" },
    });
    expect(missingCompanyPc.statusCode).toBe(400);

    for (let index = 0; index < 20; index += 1) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/node-pair/start",
        payload: { node_id: `node-${index}`, company_pc: false },
      });
      expect(response.statusCode).toBe(200);
    }
    const overflow = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/start",
      payload: { node_id: "node-overflow", company_pc: false },
    });
    expect(overflow.statusCode).toBe(429);

    await harness.app.close();
  });

  it("returns 404 for an unknown or expired device code", async () => {
    const harness = await createHarness();

    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/poll",
      payload: { device_code: "unknown" },
    });
    expect(unknown.statusCode).toBe(404);

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/start",
      payload: { node_id: "node-expire", company_pc: false },
    });
    const { device_code: deviceCode } = started.json<{ device_code: string }>();
    harness.advance(10 * 60 * 1000 + 1);

    const expired = await harness.app.inject({
      method: "POST",
      url: "/api/node-pair/poll",
      payload: { device_code: deviceCode },
    });
    expect(expired.statusCode).toBe(404);

    await harness.app.close();
  });
});
