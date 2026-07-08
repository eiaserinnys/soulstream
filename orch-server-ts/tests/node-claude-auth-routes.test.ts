import { describe, expect, it } from "vitest";

import {
  createApp,
  loadContractFixtures,
  nodeClaudeAuthRouteAuthRequirements,
  parseOrchServerConfig,
} from "../src/index.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("Claude auth route harness", () => {
  it("keeps Claude auth and provider usage routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/nodes/fake-node/claude-auth/start", undefined],
      ["GET", "/api/nodes/claude-auth/callback?code=x&state=y", undefined],
      ["GET", "/api/nodes/fake-node/claude-auth/status", undefined],
      ["GET", "/api/nodes/fake-node/claude-auth/usage", undefined],
      ["GET", "/api/nodes/fake-node/claude-auth/profile", undefined],
      ["GET", "/api/nodes/fake-node/claude-auth/profiles", undefined],
      ["DELETE", "/api/nodes/fake-node/claude-auth/token", undefined],
      ["GET", "/api/nodes/fake-node/claude-auth/headless/start", undefined],
      [
        "POST",
        "/api/nodes/fake-node/claude-auth/headless/submit-code",
        { code: "code#state" },
      ],
      ["GET", "/api/nodes/fake-node/provider-usage", undefined],
      ["GET", "/api/nodes/fake-node/provider-usage/claude", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 53-63", () => {
    expect(nodeClaudeAuthRouteAuthRequirements).toEqual({
      "GET /api/nodes/:node_id/claude-auth/start": true,
      "GET /api/nodes/claude-auth/callback": true,
      "GET /api/nodes/:node_id/claude-auth/status": true,
      "GET /api/nodes/:node_id/claude-auth/usage": true,
      "GET /api/nodes/:node_id/claude-auth/profile": true,
      "GET /api/nodes/:node_id/claude-auth/profiles": true,
      "DELETE /api/nodes/:node_id/claude-auth/token": true,
      "GET /api/nodes/:node_id/claude-auth/headless/start": true,
      "POST /api/nodes/:node_id/claude-auth/headless/submit-code": true,
      "GET /api/nodes/:node_id/provider-usage": true,
      "GET /api/nodes/:node_id/provider-usage/:provider": true,
    });

    const routeRows = loadContractFixtures().routeInventory.routes
      .filter((route) => route.order >= 53 && route.order <= 63)
      .map((route) => [
        route.order,
        route.name,
        route.methods[0],
        route.path,
        route.authRequired,
      ]);

    expect(routeRows).toEqual([
      [
        53,
        "node_claude_auth_start",
        "GET",
        "/api/nodes/{node_id}/claude-auth/start",
        true,
      ],
      [
        54,
        "node_claude_auth_callback",
        "GET",
        "/api/nodes/claude-auth/callback",
        true,
      ],
      [
        55,
        "node_claude_auth_status",
        "GET",
        "/api/nodes/{node_id}/claude-auth/status",
        true,
      ],
      [
        56,
        "node_claude_auth_usage",
        "GET",
        "/api/nodes/{node_id}/claude-auth/usage",
        true,
      ],
      [
        57,
        "node_claude_auth_profile",
        "GET",
        "/api/nodes/{node_id}/claude-auth/profile",
        true,
      ],
      [
        58,
        "node_claude_auth_profiles",
        "GET",
        "/api/nodes/{node_id}/claude-auth/profiles",
        true,
      ],
      [
        59,
        "node_claude_auth_delete_token",
        "DELETE",
        "/api/nodes/{node_id}/claude-auth/token",
        true,
      ],
      [
        60,
        "node_claude_auth_headless_start",
        "GET",
        "/api/nodes/{node_id}/claude-auth/headless/start",
        true,
      ],
      [
        61,
        "node_claude_auth_headless_submit_code",
        "POST",
        "/api/nodes/{node_id}/claude-auth/headless/submit-code",
        true,
      ],
      [62, "node_provider_usage", "GET", "/api/nodes/{node_id}/provider-usage", true],
      [
        63,
        "node_provider_usage_one",
        "GET",
        "/api/nodes/{node_id}/provider-usage/{provider}",
        true,
      ],
    ]);
  });

  it("starts browser OAuth with injected config, PKCE state, and node metadata", async () => {
    const { app, sessionStore } = createClaudeAuthHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/start",
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://claude.com/cai/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("claude-client-id");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://orch.example.com/api/nodes/claude-auth/callback",
    );
    expect(location.searchParams.get("code_challenge")).toBe("challenge-fixed");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe(
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
    expect(location.searchParams.get("state")).toBe("state-fixed");
    expect(sessionStore.created).toEqual([
      {
        state: "state-fixed",
        verifier: "verifier-fixed",
        metadata: { node_id: "fake-node" },
      },
    ]);

    await app.close();
  });

  it("handles the static OAuth callback before dynamic node routes", async () => {
    const { app, sent, sessionStore, tokenRequests } = createClaudeAuthHarness();
    sessionStore.seed("state-callback", {
      verifier: "verifier-callback",
      metadata: { node_id: "fake-node" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=callback-code&state=state-callback",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/?claude_auth=success");
    expect(tokenRequests).toEqual([
      {
        url: "https://platform.claude.com/v1/oauth/token",
        flow: "browser",
        data: {
          grant_type: "authorization_code",
          client_id: "claude-client-id",
          code: "callback-code",
          redirect_uri: "https://orch.example.com/api/nodes/claude-auth/callback",
          code_verifier: "verifier-callback",
          state: "state-callback",
        },
      },
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        type: "claude_auth_set_token",
        token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "user:profile",
      }),
    ]);

    await app.close();
  });

  it("maps OAuth callback validation, exchange, and node errors", async () => {
    const invalid = createClaudeAuthHarness();
    const invalidResponse = await invalid.app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=x&state=missing",
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toEqual({
      detail: "Invalid or expired OAuth state",
    });
    await invalid.app.close();

    const missingMetadata = createClaudeAuthHarness();
    missingMetadata.sessionStore.seed("state-missing-node", {
      verifier: "v",
      metadata: {},
    });
    const missingMetadataResponse = await missingMetadata.app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=x&state=state-missing-node",
    });
    expect(missingMetadataResponse.statusCode).toBe(400);
    expect(missingMetadataResponse.json()).toEqual({
      detail: "Missing node_id in session",
    });
    await missingMetadata.app.close();

    const failedExchange = createClaudeAuthHarness({
      tokenResponse: { statusCode: 401, text: "denied" },
    });
    failedExchange.sessionStore.seed("state-token-fail", {
      verifier: "v",
      metadata: { node_id: "fake-node" },
    });
    const failedExchangeResponse = await failedExchange.app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=x&state=state-token-fail",
    });
    expect(failedExchangeResponse.statusCode).toBe(400);
    expect(failedExchangeResponse.json()).toEqual({
      detail: "Token exchange failed: denied",
    });
    await failedExchange.app.close();

    const missingNode = createClaudeAuthHarness({ registerNode: false });
    missingNode.sessionStore.seed("state-node-missing", {
      verifier: "v",
      metadata: { node_id: "missing-node" },
    });
    const missingNodeResponse = await missingNode.app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=x&state=state-node-missing",
    });
    expect(missingNodeResponse.statusCode).toBe(404);
    expect(missingNodeResponse.json()).toEqual({
      detail: "Node missing-node not connected",
    });
    await missingNode.app.close();
  });

  it("dispatches status, delete token, usage, and profile over node commands", async () => {
    const { app, sent } = createClaudeAuthHarness();

    const status = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/status",
    });
    const usage = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/usage",
    });
    const profile = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profile",
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/nodes/fake-node/claude-auth/token",
    });

    expect(status.statusCode).toBe(200);
    expect(usage.json()).toEqual({ totalCostUsd: 1.25 });
    expect(profile.json()).toEqual({ email: "ada@example.com" });
    expect(deleted.json()).toEqual(
      expect.objectContaining({ type: "claude_auth_delete_token_ack" }),
    );
    expect(sent.map((message) => message.type)).toEqual([
      "claude_auth_status",
      "claude_auth_get_usage",
      "claude_auth_get_profile",
      "claude_auth_delete_token",
    ]);

    await app.close();
  });

  it("maps usage/profile unsuccessful acknowledgements to HTTP 400 detail", async () => {
    const { app } = createClaudeAuthHarness({
      ackFor: (message) =>
        message.type === "claude_auth_get_usage"
          ? { success: false, error: "token missing" }
          : {},
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/usage",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: "token missing" });
    await app.close();
  });

  it("proxies profile lists to the node and forwards only auth headers", async () => {
    const { app, profileRequests } = createClaudeAuthHarness({
      profileResponse: { statusCode: 200, body: { profiles: [{ id: "claude" }] } },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
        "x-extra": "must-not-forward",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profiles: [{ id: "claude" }] });
    expect(profileRequests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "http://127.0.0.1:4105/auth/claude/profiles",
        path: "/auth/claude/profiles",
        headers: { authorization: "Bearer user-token", cookie: "sid=abc" },
      }),
    ]);

    await app.close();
  });

  it("maps profile proxy missing node, upstream failure, and non-200 status", async () => {
    const missingNode = createClaudeAuthHarness({ registerNode: false });
    const missingNodeResponse = await missingNode.app.inject({
      method: "GET",
      url: "/api/nodes/missing-node/claude-auth/profiles",
    });
    expect(missingNodeResponse.statusCode).toBe(404);
    await missingNode.app.close();

    const requestFailure = createClaudeAuthHarness({
      profileHttpError: new Error("connection refused"),
    });
    const requestFailureResponse = await requestFailure.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
    });
    expect(requestFailureResponse.statusCode).toBe(502);
    await requestFailure.app.close();

    const upstreamDenied = createClaudeAuthHarness({
      profileResponse: { statusCode: 403, body: { detail: "denied" } },
    });
    const upstreamDeniedResponse = await upstreamDenied.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
    });
    expect(upstreamDeniedResponse.statusCode).toBe(403);
    expect(upstreamDeniedResponse.body).toBe("");
    await upstreamDenied.app.close();
  });
});
