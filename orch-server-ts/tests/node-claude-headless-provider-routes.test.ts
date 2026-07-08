import { describe, expect, it } from "vitest";

import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

describe("Claude headless and provider usage route harness", () => {
  it("starts headless OAuth only for connected nodes", async () => {
    const { app, sessionStore } = createClaudeAuthHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/headless/start",
    });

    expect(response.statusCode).toBe(200);
    const authUrl = new URL(response.json<{ authUrl: string }>().authUrl);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      "https://claude.com/cai/oauth/authorize",
    );
    expect(authUrl.searchParams.get("code")).toBe("true");
    expect(authUrl.searchParams.get("client_id")).toBe("claude-client-id");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(authUrl.searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
    expect(authUrl.searchParams.get("code_challenge")).toBe("challenge-fixed");
    expect(authUrl.searchParams.get("state")).toBe("state-fixed");
    expect(sessionStore.created).toEqual([
      {
        state: "state-fixed",
        verifier: "verifier-fixed",
        metadata: { node_id: "fake-node" },
      },
    ]);

    await app.close();
  });

  it("submits headless paste-code without letting body fields override commands", async () => {
    const { app, sent, sessionStore, tokenRequests } = createClaudeAuthHarness();
    sessionStore.seed("state-headless", {
      verifier: "verifier-headless",
      metadata: { node_id: "fake-node" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: {
        code: " auth-code#state-headless ",
        requestId: "evil-request",
        type: "provider_usage_get",
        fireAndForget: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(tokenRequests).toEqual([
      {
        url: "https://platform.claude.com/v1/oauth/token",
        flow: "headless",
        data: {
          grant_type: "authorization_code",
          client_id: "claude-client-id",
          code: "auth-code",
          redirect_uri: "https://platform.claude.com/oauth/code/callback",
          code_verifier: "verifier-headless",
          state: "state-headless",
        },
      },
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        type: "claude_auth_set_token",
        requestId: "claude-claude_auth_set_token-1-1700000000000",
        token: "access-token",
        refresh_token: "refresh-token",
      }),
    ]);

    await app.close();
  });

  it("validates headless paste-code shape, state, node match, node connection, and exchange", async () => {
    const missingCode = createClaudeAuthHarness();
    const missingCodeResponse = await missingCode.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "   " },
    });
    expect(missingCodeResponse.statusCode).toBe(400);
    expect(missingCodeResponse.json()).toEqual({ detail: "missing_code" });
    await missingCode.app.close();

    const invalidFormat = createClaudeAuthHarness();
    const invalidFormatResponse = await invalidFormat.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "auth-code-without-state" },
    });
    expect(invalidFormatResponse.statusCode).toBe(400);
    expect(invalidFormatResponse.json()).toEqual({ detail: "invalid_code_format" });
    await invalidFormat.app.close();

    const invalidState = createClaudeAuthHarness();
    const invalidStateResponse = await invalidState.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "auth-code#missing-state" },
    });
    expect(invalidStateResponse.statusCode).toBe(400);
    expect(invalidStateResponse.json()).toEqual({ detail: "invalid_state" });
    await invalidState.app.close();

    const mismatch = createClaudeAuthHarness();
    mismatch.sessionStore.seed("state-mismatch", {
      verifier: "v",
      metadata: { node_id: "other-node" },
    });
    const mismatchResponse = await mismatch.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "auth-code#state-mismatch" },
    });
    expect(mismatchResponse.statusCode).toBe(400);
    expect(mismatchResponse.json()).toEqual({ detail: "node_id mismatch" });
    await mismatch.app.close();

    const missingNode = createClaudeAuthHarness({ registerNode: false });
    missingNode.sessionStore.seed("state-node-missing", {
      verifier: "v",
      metadata: { node_id: "fake-node" },
    });
    const missingNodeResponse = await missingNode.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "auth-code#state-node-missing" },
    });
    expect(missingNodeResponse.statusCode).toBe(404);
    await missingNode.app.close();

    const failedExchange = createClaudeAuthHarness({
      tokenResponse: { statusCode: 400, text: "bad_code" },
    });
    failedExchange.sessionStore.seed("state-token-fail", {
      verifier: "v",
      metadata: { node_id: "fake-node" },
    });
    const failedExchangeResponse = await failedExchange.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "auth-code#state-token-fail" },
    });
    expect(failedExchangeResponse.statusCode).toBe(400);
    expect(failedExchangeResponse.json()).toEqual({
      detail: "token_exchange_failed: bad_code",
    });
    await failedExchange.app.close();
  });

  it("dispatches provider usage all and one-provider commands without route collision", async () => {
    const { app, sent } = createClaudeAuthHarness();

    const all = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/provider-usage",
    });
    const claude = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/provider-usage/claude",
    });

    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ provider: "all" });
    expect(claude.statusCode).toBe(200);
    expect(claude.json()).toEqual({ provider: "claude" });
    expect(sent).toEqual([
      expect.objectContaining({ type: "provider_usage_get" }),
      expect.objectContaining({ type: "provider_usage_get", provider: "claude" }),
    ]);
    expect(sent[0]).not.toHaveProperty("provider");

    await app.close();
  });

  it("validates provider usage whitelist before sending node commands", async () => {
    const { app, sent } = createClaudeAuthHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/provider-usage/openai",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      detail: "provider must be one of: claude, codex, gemini",
    });
    expect(sent).toEqual([]);

    await app.close();
  });

  it("maps provider usage unsuccessful acknowledgements to HTTP 400 detail", async () => {
    const { app } = createClaudeAuthHarness({
      ackFor: (message) =>
        message.type === "provider_usage_get"
          ? { success: false, error: "provider token missing" }
          : {},
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/provider-usage/codex",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ detail: "provider token missing" });
    await app.close();
  });
});
