import { describe, expect, it } from "vitest";

import { createApp, parseOrchServerConfig } from "../src/index.js";

const explicitTestConfig = {
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
};

describe("orch-server-ts config scaffold", () => {
  it("accepts explicit test config without reading production env", () => {
    expect(parseOrchServerConfig(explicitTestConfig)).toEqual(explicitTestConfig);
  });

  it("fails fast when a required config value is missing", () => {
    expect(() => parseOrchServerConfig({ ...explicitTestConfig, databaseUrl: "" })).toThrow(
      /databaseUrl/,
    );
  });

  it("creates a local-only Fastify app skeleton with an explicit health route", async () => {
    const app = createApp({
      config: parseOrchServerConfig(explicitTestConfig),
      exposeLocalHealthRoute: true,
    });

    const response = await app.inject({ method: "GET", url: "/__orch_server_ts/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      package: "@soulstream/orch-server-ts",
      environment: "test",
      routeOwnersArtifactOnly: true,
    });

    await app.close();
  });
});
