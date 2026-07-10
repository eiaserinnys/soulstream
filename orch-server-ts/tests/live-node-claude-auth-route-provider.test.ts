import { describe, expect, it, vi } from "vitest";

import {
  LiveConfigProviderError,
  LiveNodeHttpClientError,
  createLiveNodeClaudeAuthOAuthConfigProvider,
  createLiveNodeClaudeAuthPkceProvider,
  createLiveNodeClaudeAuthProfileHttpClient,
  type LiveConfigProviderBoundary,
  type NodeConnectionSnapshot,
} from "../src/index.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

const targetNode: NodeConnectionSnapshot = {
  nodeId: "fake-node",
  connectionId: "conn-1",
  host: "ignored-host",
  port: 4105,
  agents: [],
  capabilities: {},
  supportedBackends: [],
  connected: true,
  status: "connected",
  connectedAtMs: 1_700_000_000_000,
  disconnectedAtMs: undefined,
  lastSeenAtMs: 1_700_000_000_000,
  heartbeat: {
    supported: false,
    lastPingAtMs: undefined,
    lastPongAtMs: undefined,
  },
  pendingCommandCount: 0,
};

describe("live node Claude auth route provider", () => {
  it("reads OAuth client config from the live config boundary", async () => {
    const configProvider = createConfigProvider({
      claude_oauth_client_id: "live-claude-client",
      claude_oauth_callback_url:
        "https://orch.example.test/api/nodes/claude-auth/callback",
    });
    const provider = createLiveNodeClaudeAuthOAuthConfigProvider({
      configProvider,
    });

    await expect(provider.getOAuthConfig()).resolves.toEqual({
      clientId: "live-claude-client",
      callbackUrl: "https://orch.example.test/api/nodes/claude-auth/callback",
    });
    expect(configProvider.requireConfig).toHaveBeenCalledWith(
      "claude_oauth_client_id",
    );
    expect(configProvider.requireConfig).toHaveBeenCalledWith(
      "claude_oauth_callback_url",
    );
  });

  it("fails with a typed config error when OAuth config is missing", async () => {
    const configProvider = createConfigProvider({
      claude_oauth_client_id: "live-claude-client",
    });
    const provider = createLiveNodeClaudeAuthOAuthConfigProvider({
      configProvider,
    });

    await expect(provider.getOAuthConfig()).rejects.toBeInstanceOf(
      LiveConfigProviderError,
    );
    await expect(provider.getOAuthConfig()).rejects.toMatchObject({
      failures: [
        {
          owner: "node.claude-auth",
          path: "nodeClaudeAuthRoutes.provider",
          key: "claude_oauth_callback_url",
          reason: "missing",
          expected: "string",
          actualType: "undefined",
        },
      ],
    });
  });

  it("fails with a typed config error when OAuth config type is invalid", async () => {
    const configProvider = createConfigProvider({
      claude_oauth_client_id: 123,
      claude_oauth_callback_url:
        "https://orch.example.test/api/nodes/claude-auth/callback",
    });
    const provider = createLiveNodeClaudeAuthOAuthConfigProvider({
      configProvider,
    });

    await expect(provider.getOAuthConfig()).rejects.toMatchObject({
      failures: [
        {
          owner: "node.claude-auth",
          path: "nodeClaudeAuthRoutes.provider",
          key: "claude_oauth_client_id",
          reason: "invalid_type",
          expected: "string",
          actualType: "number",
        },
      ],
    });
  });

  it("uses live provider config for browser and headless OAuth start", async () => {
    const configProvider = createConfigProvider({
      claude_oauth_client_id: "live-claude-client",
      claude_oauth_callback_url:
        "https://orch.example.test/api/nodes/claude-auth/callback",
    });
    const provider = createLiveNodeClaudeAuthOAuthConfigProvider({
      configProvider,
    });

    const browser = createClaudeAuthHarness({ provider });
    const browserResponse = await browser.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/start",
    });
    expect(browserResponse.statusCode).toBe(302);
    const browserLocation = new URL(String(browserResponse.headers.location));
    expect(browserLocation.searchParams.get("client_id")).toBe(
      "live-claude-client",
    );
    expect(browserLocation.searchParams.get("redirect_uri")).toBe(
      "https://orch.example.test/api/nodes/claude-auth/callback",
    );
    await browser.app.close();

    const headless = createClaudeAuthHarness({ provider });
    const headlessResponse = await headless.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/headless/start",
    });
    expect(headlessResponse.statusCode).toBe(200);
    const headlessUrl = new URL(
      headlessResponse.json<{ authUrl: string }>().authUrl,
    );
    expect(headlessUrl.searchParams.get("client_id")).toBe("live-claude-client");
    expect(headlessUrl.searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(configProvider.requireConfig).toHaveBeenCalledWith(
      "claude_oauth_client_id",
    );
    expect(configProvider.requireConfig).toHaveBeenCalledWith(
      "claude_oauth_callback_url",
    );
    await headless.app.close();
  });

  it("generates Python-compatible PKCE verifier and state values", () => {
    const sizes: number[] = [];
    const provider = createLiveNodeClaudeAuthPkceProvider({
      randomBytes: (size) => {
        sizes.push(size);
        return Buffer.from(Array.from({ length: size }, (_value, index) => index));
      },
    });

    expect(provider.generateVerifier()).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    );
    expect(provider.generateState()).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    );
    expect(sizes).toEqual([32, 32]);
  });

  it("generates SHA-256 S256 challenges from ASCII verifiers", () => {
    const provider = createLiveNodeClaudeAuthPkceProvider();

    expect(
      provider.generateChallenge(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("returns URL-safe no-padding 32-byte verifier and state strings", () => {
    const provider = createLiveNodeClaudeAuthPkceProvider({
      randomBytes: () => Buffer.alloc(32, 255),
    });

    for (const value of [provider.generateVerifier(), provider.generateState()]) {
      expect(value).toHaveLength(43);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value).not.toContain("=");
    }
  });

  it("uses live PKCE values for browser and headless OAuth start", async () => {
    const provider = createLiveNodeClaudeAuthOAuthConfigProvider({
      configProvider: createConfigProvider({
        claude_oauth_client_id: "live-claude-client",
        claude_oauth_callback_url:
          "https://orch.example.test/api/nodes/claude-auth/callback",
      }),
    });
    const pkce = createLiveNodeClaudeAuthPkceProvider({
      randomBytes: sequentialBytes([
        Buffer.from(Array.from({ length: 32 }, (_value, index) => index)),
        Buffer.alloc(32, 255),
        Buffer.from(Array.from({ length: 32 }, (_value, index) => 31 - index)),
        Buffer.alloc(32, 1),
      ]),
    });

    const browser = createClaudeAuthHarness({ provider, pkce });
    const browserResponse = await browser.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/start",
    });
    expect(browserResponse.statusCode).toBe(302);
    const browserLocation = new URL(String(browserResponse.headers.location));
    expect(browserLocation.searchParams.get("state")).toBe(
      "__________________________________________8",
    );
    expect(browserLocation.searchParams.get("code_challenge")).toBe(
      "6oZqdX5MOLq_qBJ8vppAnT4fk6AP8UiP9zX8-Rev_9A",
    );
    expect(browser.sessionStore.created).toEqual([
      {
        state: "__________________________________________8",
        verifier: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        metadata: { node_id: "fake-node" },
      },
    ]);
    await browser.app.close();

    const headless = createClaudeAuthHarness({ provider, pkce });
    const headlessResponse = await headless.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/headless/start",
    });
    expect(headlessResponse.statusCode).toBe(200);
    const headlessUrl = new URL(
      headlessResponse.json<{ authUrl: string }>().authUrl,
    );
    expect(headlessUrl.searchParams.get("state")).toBe(
      "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    );
    expect(headlessUrl.searchParams.get("code_challenge")).toBe(
      "hPUmsR8zpTd_x0LYm0rwAsdfEv6A0_gR5AnDa0Abxnc",
    );
    expect(headless.sessionStore.created).toEqual([
      {
        state: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        verifier: "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA",
        metadata: { node_id: "fake-node" },
      },
    ]);
    await headless.app.close();
  });

  it("forwards explicit profile request fields through the live node HTTP boundary", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { profiles: [{ id: "claude" }] },
    }));
    const httpClient = createLiveNodeClaudeAuthProfileHttpClient({
      nodeHttpClient: { requestNode },
    });

    const response = await httpClient({
      method: "GET",
      url: "http://python-proxy.invalid/this/path/must/not/be/used",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      node: targetNode,
    });

    expect(response).toEqual({
      statusCode: 200,
      body: { profiles: [{ id: "claude" }] },
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "fake-node",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });
  });

  it("passes non-2xx upstream responses through without throwing", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: { detail: "unauthorized" },
    }));
    const httpClient = createLiveNodeClaudeAuthProfileHttpClient({
      nodeHttpClient: { requestNode },
    });

    await expect(
      httpClient({
        method: "GET",
        url: "http://ignored.example.test/auth/claude/profiles",
        path: "/auth/claude/profiles",
        headers: {},
        node: targetNode,
      }),
    ).resolves.toEqual({
      statusCode: 401,
      body: { detail: "unauthorized" },
    });
  });

  it("lets the existing route return non-200 upstream status without a Python fallback", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 403,
      body: { detail: "denied" },
    }));
    const app = createClaudeAuthHarness({
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient({
        nodeHttpClient: { requestNode },
      }),
    });

    const response = await app.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("");
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "fake-node",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    await app.app.close();
  });

  it.each([
    [
      "stale node",
      new LiveNodeHttpClientError("NODE_HTTP_TARGET_STALE", "stale node", {
        nodeId: "fake-node",
      }),
    ],
    ["request failure", new Error("request failed")],
  ])("maps %s errors to the existing profile route 502 catch", async (_label, error) => {
    const requestNode = vi.fn(async () => {
      throw error;
    });
    const app = createClaudeAuthHarness({
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient({
        nodeHttpClient: { requestNode },
      }),
    });

    const response = await app.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).toBe("");
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "fake-node",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    await app.app.close();
  });
});

function createConfigProvider(
  config: Readonly<Record<string, unknown>>,
): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => config),
    requireConfig: vi.fn(async (key: string) => {
      const value = config[key];
      if (value === undefined) throw new Error(`missing config: ${key}`);
      return value;
    }),
  };
}

function sequentialBytes(values: Buffer[]): (size: number) => Buffer {
  const queue = [...values];
  return (size) => {
    const value = queue.shift();
    if (value === undefined) throw new Error("randomBytes called too many times");
    expect(size).toBe(value.length);
    return value;
  };
}
