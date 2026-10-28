import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  nodeClaudeAuthRouteAuthRequirements,
  parseOrchServerConfig,
} from "../src/index.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";
import type { UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";

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
      ["GET", "/api/nodes/fake-node/claude-auth/accounts", undefined],
      ["PATCH", "/api/nodes/fake-node/claude-auth/accounts/11111111-1111-4111-8111-111111111111", { enabled: true }],
      ["DELETE", "/api/nodes/fake-node/claude-auth/accounts/11111111-1111-4111-8111-111111111111", undefined],
      ["POST", "/api/nodes/fake-node/claude-auth/logins", {}],
      ["GET", "/api/nodes/fake-node/claude-auth/logins/login-a", undefined],
      ["POST", "/api/nodes/fake-node/claude-auth/logins/login-a/code", { code: "x" }],
      ["DELETE", "/api/nodes/fake-node/claude-auth/logins/login-a", undefined],
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
      "GET /api/nodes/:node_id/claude-auth/accounts": true,
      "PATCH /api/nodes/:node_id/claude-auth/accounts/:id": true,
      "DELETE /api/nodes/:node_id/claude-auth/accounts/:id": true,
      "POST /api/nodes/:node_id/claude-auth/logins": true,
      "GET /api/nodes/:node_id/claude-auth/logins/:login_id": true,
      "POST /api/nodes/:node_id/claude-auth/logins/:login_id/code": true,
      "DELETE /api/nodes/:node_id/claude-auth/logins/:login_id": true,
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

it("accepts Antigravity provider usage through the existing REST route", async () => {
  const { app, sent } = createClaudeAuthHarness();
  const response = await app.inject({ method: "GET", url: "/api/nodes/fake-node/provider-usage/antigravity" });
  expect(response.statusCode).toBe(200);
  expect(sent).toContainEqual(expect.objectContaining({ type: "provider_usage_get", provider: "antigravity" }));
  await app.close();
});

describe("legacy Claude OAuth routes on account-pool nodes", () => {
  it("returns login_flow_required before starting PKCE or exchanging codes", async () => {
    const { app, sessionStore, tokenRequests, sent } = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
    });
    sessionStore.seed("legacy-callback-state", {
      verifier: "legacy-verifier",
      metadata: { node_id: "fake-node" },
    });

    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/nodes/fake-node/claude-auth/start",
      }),
      app.inject({
        method: "GET",
        url: "/api/nodes/claude-auth/callback?code=synthetic-auth-code&state=legacy-callback-state",
      }),
      app.inject({
        method: "GET",
        url: "/api/nodes/fake-node/claude-auth/headless/start",
      }),
      app.inject({
        method: "POST",
        url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
        payload: { code: "synthetic-auth-code#legacy-state" },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/nodes/fake-node/claude-auth/token",
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "login_flow_required" },
      });
      expect(response.body).not.toContain("synthetic-auth-code");
    }
    expect(sessionStore.created).toEqual([]);
    expect(tokenRequests).toEqual([]);
    expect(sent).toEqual([]);

    await app.close();
  });
});

describe("Claude account-pool REST routes", () => {
  it("dispatches all seven account and login routes and refreshes summaries after mutations", async () => {
    const account = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "pool@example.com",
      plan: null,
      enabled: true,
      priority: null,
      auth_state: "ok" as const,
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: null,
      blocked: null,
      active_sessions: 0,
    };
    const updatedList = {
      mode: "pool" as const,
      accounts: [account],
      pool: { available_count: 1, total_count: 1, best_weekly_remaining_percent: 80, best_weekly_resets_at: null, earliest_available_at: null },
      fable_pool: null,
    };
    const refreshedSummary: UsageSummarySnapshot = {
      generatedAt: "2026-10-12T03:00:00.000Z",
      collectedAt: "2026-10-12T03:00:00.000Z",
      nodes: [{
        nodeId: "fake-node",
        fetchedAt: "2026-10-12T03:00:00.000Z",
        stale: false,
        staleSince: null,
        providers: {
          claude: {
            status: "auto",
            weeklyRemainingPercent: 80,
            weeklyResetAt: null,
            shortRemainingPercent: null,
            shortResetAt: null,
            quotas: [],
            ...updatedList,
          },
          codex: null,
          antigravity: null,
        },
      }],
    };
    const refreshNode = vi.fn(async () => refreshedSummary);
    const { app, sent } = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      usageSummary: { refreshNode },
    });
    const base = "/api/nodes/fake-node/claude-auth";

    const listed = await app.inject({ method: "GET", url: `${base}/accounts` });
    const patched = await app.inject({
      method: "PATCH",
      url: `${base}/accounts/${account.id}`,
      payload: { enabled: true, priority: null },
    });
    const deleted = await app.inject({ method: "DELETE", url: `${base}/accounts/${account.id}` });
    const started = await app.inject({
      method: "POST",
      url: `${base}/logins`,
      payload: { account_id: account.id },
    });
    const status = await app.inject({ method: "GET", url: `${base}/logins/login-a` });
    const submitted = await app.inject({
      method: "POST",
      url: `${base}/logins/login-a/code`,
      payload: { code: "oauth-code#state-value" },
    });
    const cancelled = await app.inject({ method: "DELETE", url: `${base}/logins/login-a` });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ mode: "pool", accounts: [] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual(updatedList);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deferred: false, accounts: [account], pool: updatedList.pool });
    expect(started.statusCode).toBe(202);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: "done", login_id: "login-a" });
    expect(submitted.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(200);
    expect(refreshNode).toHaveBeenCalledTimes(3);
    expect(sent.map((message) => message.type)).toEqual([
      "claude_auth_accounts_list",
      "claude_auth_account_update",
      "claude_auth_account_delete",
      "claude_auth_login_start",
      "claude_auth_login_status",
      "claude_auth_login_submit_code",
      "claude_auth_login_cancel",
    ]);
    expect(sent[1]).toMatchObject({ account_id: account.id, enabled: true, priority: null });
    expect(sent[2]).toMatchObject({ account_id: account.id });
    expect(sent[3]).toMatchObject({ account_id: account.id });
    expect(sent[5]).toMatchObject({ login_id: "login-a", code: "oauth-code#state-value" });

    await app.close();
  });

  it("rejects unsupported nodes and maps validated, account, and transport errors without echoing secrets", async () => {
    const unsupported = createClaudeAuthHarness();
    const unsupportedResponses = await Promise.all([
      unsupported.app.inject({ method: "GET", url: "/api/nodes/fake-node/claude-auth/accounts" }),
      unsupported.app.inject({ method: "PATCH", url: "/api/nodes/fake-node/claude-auth/accounts/11111111-1111-4111-8111-111111111111", payload: { enabled: true } }),
      unsupported.app.inject({ method: "DELETE", url: "/api/nodes/fake-node/claude-auth/accounts/11111111-1111-4111-8111-111111111111" }),
      unsupported.app.inject({ method: "POST", url: "/api/nodes/fake-node/claude-auth/logins", payload: {} }),
      unsupported.app.inject({ method: "GET", url: "/api/nodes/fake-node/claude-auth/logins/login-a" }),
      unsupported.app.inject({ method: "POST", url: "/api/nodes/fake-node/claude-auth/logins/login-a/code", payload: { code: "private-code" } }),
      unsupported.app.inject({ method: "DELETE", url: "/api/nodes/fake-node/claude-auth/logins/login-a" }),
    ]);
    for (const unsupportedResponse of unsupportedResponses) {
      expect(unsupportedResponse.statusCode).toBe(409);
      expect(unsupportedResponse.json()).toEqual({
        code: "claude_account_pool_unsupported",
        message: "이 노드는 Claude 계정 풀을 지원하지 않습니다.",
      });
      expect(unsupportedResponse.body).not.toContain("private-code");
    }
    expect(unsupported.sent).toEqual([]);
    await unsupported.app.close();

    const invalid = createClaudeAuthHarness({ claudeAccountPoolEnabled: true });
    const invalidResponse = await invalid.app.inject({
      method: "PATCH",
      url: "/api/nodes/fake-node/claude-auth/accounts/not-a-uuid",
      payload: { enabled: true },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toEqual({
      code: "invalid_request",
      message: "올바르지 않은 Claude 계정 ID입니다.",
    });
    const invalidInputs = await Promise.all([
      invalid.app.inject({ method: "PATCH", url: "/api/nodes/fake-node/claude-auth/accounts/11111111-1111-4111-8111-111111111111", payload: { enabled: "invalid" } }),
      invalid.app.inject({ method: "POST", url: "/api/nodes/fake-node/claude-auth/logins", payload: { account_id: "not-a-uuid" } }),
      invalid.app.inject({ method: "POST", url: "/api/nodes/fake-node/claude-auth/logins/login-a/code", payload: { code: "" } }),
    ]);
    expect(invalidInputs.map((response) => [response.statusCode, response.json()])).toEqual([
      [400, { code: "invalid_request", message: "올바르지 않은 Claude 계정 수정 요청입니다." }],
      [400, { code: "invalid_request", message: "올바르지 않은 Claude 로그인 요청입니다." }],
      [400, { code: "invalid_request", message: "올바르지 않은 Claude 인증 코드입니다." }],
    ]);
    await invalid.app.close();

    const missingNode = createClaudeAuthHarness({ claudeAccountPoolEnabled: true, registerNode: false });
    const missingNodeResponse = await missingNode.app.inject({
      method: "GET",
      url: "/api/nodes/missing-node/claude-auth/accounts",
    });
    expect(missingNodeResponse.statusCode).toBe(404);
    expect(missingNodeResponse.json()).toEqual({
      code: "node_not_connected",
      message: "노드가 연결되어 있지 않습니다.",
    });
    await missingNode.app.close();

    const accountExists = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      ackFor: (message) => message.type === "claude_auth_login_submit_code"
        ? { success: false, error: { code: "ACCOUNT_EXISTS", message: "oauth-code#state-value https://private.example", existing_account_id: "22222222-2222-4222-8222-222222222222" } }
        : {},
    });
    const duplicate = await accountExists.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/logins/login-a/code",
      payload: { code: "oauth-code#state-value" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      code: "account_exists",
      message: "이미 등록된 Claude 계정입니다.",
      existing_account_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(duplicate.body).not.toContain("oauth-code#state-value");
    expect(duplicate.body).not.toContain("https://private.example");
    await accountExists.app.close();

    const notFound = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      ackFor: (message) => message.type === "claude_auth_account_update"
        ? { success: false, error: { code: "account_not_found", message: "private detail" } }
        : {},
    });
    const missingAccount = await notFound.app.inject({
      method: "PATCH",
      url: "/api/nodes/fake-node/claude-auth/accounts/11111111-1111-4111-8111-111111111111",
      payload: { enabled: false },
    });
    expect(missingAccount.statusCode).toBe(404);
    expect(missingAccount.json()).toEqual({ code: "account_not_found", message: "Claude 계정을 찾을 수 없습니다." });
    await notFound.app.close();

    const disconnected = createClaudeAuthHarness({ claudeAccountPoolEnabled: true, attachTransport: false });
    const upstreamFailure = await disconnected.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/accounts",
    });
    expect(upstreamFailure.statusCode).toBe(502);
    expect(upstreamFailure.json()).toMatchObject({ code: expect.any(String), message: "Claude 계정 노드 요청을 처리하지 못했습니다." });
    await disconnected.app.close();
  });

  it.each([
    { code: "invalid_code", status: 400, method: "POST", path: "/logins/login-a/code", payload: { code: "worker-valid-code" } },
    { code: "invalid_login_code", status: 400, method: "POST", path: "/logins/login-a/code", payload: { code: "worker-valid-code" } },
    { code: "ACCOUNT_NOT_FOUND", status: 404, method: "PATCH", path: "/accounts/11111111-1111-4111-8111-111111111111", payload: { enabled: false } },
    { code: "account_not_found", status: 404, method: "POST", path: "/logins", payload: { account_id: "11111111-1111-4111-8111-111111111111" } },
    { code: "login_not_found", status: 404, method: "GET", path: "/logins/login-a" },
    { code: "account_exists", status: 409, method: "POST", path: "/logins/login-a/code", payload: { code: "worker-valid-code" } },
    { code: "account_identity_mismatch", status: 409, method: "POST", path: "/logins/login-a/code", payload: { code: "worker-valid-code" } },
    { code: "login_flow_required", status: 409, method: "POST", path: "/logins", payload: {} },
    { code: "login_in_progress", status: 409, method: "POST", path: "/logins", payload: {} },
    { code: "LOGIN_SESSION_CONFLICT", status: 409, method: "POST", path: "/logins", payload: {} },
    { code: "login_session_conflict", status: 409, method: "POST", path: "/logins", payload: {} },
    { code: "login_not_ready", status: 409, method: "POST", path: "/logins/login-a/code", payload: { code: "worker-valid-code" } },
    { code: "ACCOUNT_UPDATE_FAILED", status: 502, method: "PATCH", path: "/accounts/11111111-1111-4111-8111-111111111111", payload: { enabled: false } },
    { code: "ACCOUNT_DELETE_FAILED", status: 502, method: "DELETE", path: "/accounts/11111111-1111-4111-8111-111111111111" },
    { code: "login_spawn_failed", status: 502, method: "POST", path: "/logins", payload: {} },
    { code: "login_stdin_failed", status: 502, method: "POST", path: "/logins/login-a/code", payload: { code: "worker-valid-code" } },
    { code: "login_process_failed", status: 502, method: "GET", path: "/logins/login-a" },
    { code: "auth_status_failed", status: 502, method: "GET", path: "/logins/login-a" },
    { code: "account_uuid_missing", status: 502, method: "GET", path: "/logins/login-a" },
    { code: "login_verification_failed", status: 502, method: "GET", path: "/logins/login-a" },
    { code: "login_timed_out", status: 502, method: "GET", path: "/logins/login-a" },
    { code: "login_flow_failed", status: 502, method: "POST", path: "/logins", payload: {} },
  ] as const)("maps worker error $code to HTTP $status", async ({ code, status, method, path, payload }) => {
    const harness = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      ackFor: () => ({ success: false, error: { code, message: "private OAuth code https://private.example/login" } }),
    });

    const response = await harness.app.inject({
      method,
      url: `/api/nodes/fake-node/claude-auth${path}`,
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(status);
    const normalizedCodes: Readonly<Record<string, string>> = {
      ACCOUNT_NOT_FOUND: "account_not_found",
      ACCOUNT_UPDATE_FAILED: "account_update_failed",
      ACCOUNT_DELETE_FAILED: "account_delete_failed",
      LOGIN_SESSION_CONFLICT: "login_session_conflict",
    };
    const normalizedCode = normalizedCodes[code] ?? code;
    const messages: Readonly<Record<string, string>> = {
      account_exists: "이미 등록된 Claude 계정입니다.",
      account_identity_mismatch: "인증된 Claude 계정이 요청한 계정과 일치하지 않습니다.",
      account_not_found: "Claude 계정을 찾을 수 없습니다.",
      login_not_found: "Claude 로그인 세션을 찾을 수 없습니다.",
      login_flow_required: "Claude 계정 로그인 절차를 사용해 주세요.",
      login_in_progress: "이미 진행 중인 Claude 로그인이 있습니다.",
      login_session_conflict: "이미 진행 중인 Claude 로그인이 있습니다.",
      login_not_ready: "아직 인증 코드를 입력할 수 있는 상태가 아닙니다.",
      invalid_code: "올바르지 않은 Claude 인증 코드입니다.",
      invalid_login_code: "올바르지 않은 Claude 인증 코드입니다.",
    };
    expect(response.json()).toEqual({
      code: normalizedCode,
      message: messages[normalizedCode] ?? "Claude 계정 요청이 거절되었습니다.",
    });
    expect(response.body).not.toContain("private OAuth code");
    expect(response.body).not.toContain("https://private.example/login");
    await harness.app.close();
  });

  it("maps pending command timeout and a detached node transport to safe 502 errors", async () => {
    const timedOut = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      timeoutMs: 10,
      withholdAck: (message) => message.type === "claude_auth_accounts_list",
    });
    const timeoutResponse = await timedOut.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/accounts",
    });
    expect(timeoutResponse.statusCode).toBe(502);
    expect(timeoutResponse.json()).toEqual({
      code: "node_command_timeout",
      message: "Claude 계정 노드 요청을 처리하지 못했습니다.",
    });
    await timedOut.app.close();

    const detached = createClaudeAuthHarness({ claudeAccountPoolEnabled: true });
    expect(detached.connectionId).toBeDefined();
    detached.transports.detach({ nodeId: "fake-node", connectionId: detached.connectionId! });
    const detachedResponse = await detached.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/accounts",
    });
    expect(detachedResponse.statusCode).toBe(502);
    expect(detachedResponse.json()).toEqual({
      code: "node_command_failed",
      message: "Claude 계정 노드 요청을 처리하지 못했습니다.",
    });
    await detached.app.close();
  });

  it("logs a real production auth rejection without writing request code or auth URL", async () => {
    const logs: string[] = [];
    const authUrl = "https://claude.com/cai/oauth/authorize?code=true&state=private-state";
    const code = "private-oauth-code#private-state";
    const harness = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      config: parseOrchServerConfig({
        environment: "production",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: "test-token",
      }),
      productionAuth: {
        resolveTokenAccess: async () => ({
          ok: false,
          statusCode: 401,
          detail: "Authorization header required",
        }),
      },
      logDestination: { write: (message) => logs.push(message) },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/nodes/fake-node/claude-auth/logins/login-a/code?auth_url=${encodeURIComponent(authUrl)}`,
      payload: { code },
    });

    expect(response.statusCode).toBe(401);
    expect(harness.sent).toEqual([]);
    await harness.app.close();
    expect(logs.join("\n")).not.toContain(code);
    expect(logs.join("\n")).not.toContain(authUrl);
    expect(logs.join("\n")).not.toContain("private-state");
  });

  it("aliases pool-node profile lists to the accounts command while preserving legacy HTTP proxy", async () => {
    const pool = createClaudeAuthHarness({ claudeAccountPoolEnabled: true });
    const poolResponse = await pool.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
    });
    expect(poolResponse.statusCode).toBe(200);
    expect(poolResponse.json()).toMatchObject({ mode: "pool", accounts: [] });
    expect(pool.sent.map((message) => message.type)).toEqual(["claude_auth_accounts_list"]);
    expect(pool.profileRequests).toEqual([]);
    await pool.app.close();

    const legacy = createClaudeAuthHarness();
    const legacyResponse = await legacy.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
    });
    expect(legacyResponse.json()).toEqual({ profiles: [] });
    expect(legacy.profileRequests).toHaveLength(1);
    expect(legacy.sent).toEqual([]);
    await legacy.app.close();
  });
});
