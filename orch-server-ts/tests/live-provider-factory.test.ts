import { describe, expect, it, vi } from "vitest";

import {
  createLiveOrchestratorProviderBundle,
  createOrchestratorRuntimeServices,
  liveFactoryImplementedProviderPaths,
  liveProviderDependencyCategories,
  liveProviderWiringInventory,
  parseOrchServerConfig,
  validateLiveProviderFactoryInventoryAlignment,
  LiveProviderFactoryError,
  type LiveProviderDependencies,
  type NodeConnectionSnapshot,
  type LiveProviderWiringInventoryEntry,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const nodeClaudeAuthProfileNode: NodeConnectionSnapshot = {
  nodeId: "node-claude",
  connectionId: "conn-claude",
  host: "ignored",
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
    timeoutMs: 0,
    lastPingAtMs: undefined,
    lastPongAtMs: undefined,
  },
  pendingCommandCount: 0,
};

describe("live provider factory boundary", () => {
  it("requires explicit dependency categories for live wiring", () => {
    const dependencies = createLiveDependencies();

    expect(liveProviderDependencyCategories).toEqual([
      "authSessionIdentity",
      "dbCatalogRepository",
      "nodeHttpClient",
      "fileBlobR2Storage",
      "jwtToken",
      "claudeOAuth",
      "pushRepository",
      "configProvider",
      "systemPortraitAssets",
    ]);
    expect(Object.keys(dependencies).sort()).toEqual(
      [...liveProviderDependencyCategories].sort(),
    );
  });

  it("keeps the factory provided paths aligned with implemented inventory entries", () => {
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: liveFactoryImplementedProviderPaths,
    });

    expect(result.missingImplementedProviderPaths).toEqual([]);
    expect(result.extraFactoryProviderPaths).toEqual([]);
    expect(result.blockedFactoryProviderPaths).toEqual([]);
    expect(result.implementedInventoryProviderPaths).toEqual(
      liveFactoryImplementedProviderPaths,
    );
    expect(result.unresolvedProviderPaths.length).toBeGreaterThan(0);
  });

  it("fails when inventory marks a path implemented but the factory omits it", () => {
    const [firstPath, ...remainingFactoryPaths] = liveFactoryImplementedProviderPaths;
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: remainingFactoryPaths,
    });

    expect(result.missingImplementedProviderPaths).toEqual([firstPath]);
  });

  it("fails when the factory provides a path absent from inventory", () => {
    const extraPath = { owner: "unknown.owner", path: "unknown.provider" };
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: [...liveFactoryImplementedProviderPaths, extraPath],
    });

    expect(result.extraFactoryProviderPaths).toEqual([extraPath]);
  });

  it("fails when the factory tries to provide a blocked path", () => {
    const blockedPath = { owner: "atom", path: "atomRoutes.httpClient" };
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: [...liveFactoryImplementedProviderPaths, blockedPath],
    });

    expect(result.blockedFactoryProviderPaths).toEqual([
      expect.objectContaining({
        owner: "atom",
        path: "atomRoutes.httpClient",
        status: "blocked",
      }),
    ]);
  });

  it("throws a typed error before returning a bundle while stub or blocked paths remain", () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);

    expect(() =>
      createLiveOrchestratorProviderBundle({
        dependencies,
        runtimeServices,
      }),
    ).toThrowError(LiveProviderFactoryError);

    try {
      createLiveOrchestratorProviderBundle({
        dependencies,
        runtimeServices,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LiveProviderFactoryError);
      expect((error as LiveProviderFactoryError).failures[0]).toMatchObject({
        owner: "admin.users",
        path: "adminUsersRoutes.provider",
        status: "stub",
        source: expect.any(String),
        notes: expect.any(String),
      });
      expect((error as Error).message).toContain("admin.users");
    }
  });

  it("returns implemented runtime and config route providers when the inventory is fully implemented", async () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);
    const implementedOnly = liveProviderWiringInventory.filter(
      (entry): entry is Extract<LiveProviderWiringInventoryEntry, { status: "implemented" }> =>
        entry.status === "implemented",
    );

    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      inventory: implementedOnly,
    });

    expect(bundle.implementedProviderPaths).toEqual(liveFactoryImplementedProviderPaths);
    expect(bundle.cogitoRoutes.provider.listConnectedNodes()).toEqual([]);
    expect(bundle.cogitoRoutes.briefCollector.reflectBrief).toEqual(expect.any(Function));
    await expect(
      bundle.cogitoRoutes.httpClient.get({
        nodeId: "node-a",
        url: "http://ignored.example.test/cogito/search",
        params: {
          q: "hello",
          top_k: 2,
          search_session_id: false,
        },
        headers: { authorization: "Bearer token" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(dependencies.nodeHttpClient.requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/cogito/search?q=hello&top_k=2&search_session_id=false",
      headers: { authorization: "Bearer token" },
    });
    await expect(
      bundle.configProviders.publicStatusRoutes.configProvider.getConfig(),
    ).resolves.toEqual({
      nodeName: "orch-live",
      authEnabled: true,
      atomEnabled: true,
    });
    await expect(
      bundle.authRoutes.configProvider.getConfig(),
    ).resolves.toMatchObject({
      authEnabled: true,
      devModeEnabled: false,
      googleClientId: "google-client",
      googleClientSecret: "google-secret",
      callbackUrl: "/api/auth/google/callback",
      jwtSecretConfigured: true,
    });
    expect(bundle.authRoutes.httpClient.post).toEqual(expect.any(Function));
    expect(bundle.authRoutes.httpClient.get).toEqual(expect.any(Function));
    expect(bundle.authRoutes.jwt.issueToken).toEqual(expect.any(Function));
    expect(bundle.authRoutes.jwt.verifyToken).toEqual(expect.any(Function));
    expect(bundle.authRoutes.nativeVerifier).toEqual(expect.any(Function));
    expect(bundle.authRoutes.resolveTokenAccess).toEqual(expect.any(Function));
    expect(bundle.authRoutes.authorizeUser).toEqual(expect.any(Function));
    expect(bundle.authRoutes.userPayloadExtra).toEqual(expect.any(Function));
    expect(bundle.folderRoutes.accessProvider.resolveAccess).toEqual(expect.any(Function));
    expect(bundle.boardItemRoutes.accessProvider.resolveAccess).toEqual(expect.any(Function));
    expect(bundle.markdownDocumentRoutes.accessProvider.resolveAccess).toEqual(
      expect.any(Function),
    );
    expect(bundle.runbookRoutes.accessProvider.resolveAccess).toEqual(expect.any(Function));
    await expect(
      bundle.configProviders.atomRoutes.configProvider.getConfig(),
    ).resolves.toEqual({
      atomEnabled: true,
      atomServerUrl: "https://atom.example.test",
      atomApiKey: "atom-secret",
      atomRootNodeId: "root-node",
    });
    await expect(
      bundle.systemConfigRoutes.provider.getSystemPortrait("system"),
    ).resolves.toEqual({
      body: Buffer.from("system-portrait"),
    });
    expect(bundle.systemConfigRoutes.provider.listConnectedNodes()).toEqual([]);
    await expect(
      bundle.systemConfigRoutes.httpClient({
        method: "PUT",
        url: "http://ignored.example.test/api/config/settings",
        path: "/api/config/settings",
        headers: { cookie: "sid=abc" },
        body: { changes: { KEY: "value" } },
        node: { nodeId: "node-system", host: "ignored", port: 4105 },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(dependencies.nodeHttpClient.requestNode).toHaveBeenCalledWith({
      nodeId: "node-system",
      method: "PUT",
      path: "/api/config/settings",
      headers: { cookie: "sid=abc" },
      body: { changes: { KEY: "value" } },
    });
    const runbookPayload = {
      status: "completed",
      expectedVersion: 4,
      idempotencyKey: "idem-runbook",
    };
    await expect(
      bundle.runbookRoutes.httpClient({
        method: "POST",
        url: "http://ignored.example.test/legacy-python-proxy",
        upstreamPath: "/api/runbooks/rb%2F1/status",
        headers: { cookie: "sid=runbook", authorization: "Bearer runbook" },
        body: runbookPayload,
        target: { nodeId: "node-runbook", host: "ignored", port: 4105 },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(dependencies.nodeHttpClient.requestNode).toHaveBeenCalledWith({
      nodeId: "node-runbook",
      method: "POST",
      path: "/api/runbooks/rb%2F1/status",
      headers: { cookie: "sid=runbook", authorization: "Bearer runbook" },
      body: runbookPayload,
    });
    await expect(
      bundle.nodeClaudeAuthRoutes.profileHttpClient({
        method: "GET",
        url: "http://ignored.example.test/auth/claude/profiles",
        path: "/auth/claude/profiles",
        headers: { cookie: "sid=claude", authorization: "Bearer claude" },
        node: nodeClaudeAuthProfileNode,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(dependencies.nodeHttpClient.requestNode).toHaveBeenCalledWith({
      nodeId: "node-claude",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=claude", authorization: "Bearer claude" },
    });
    await expect(
      bundle.nodeClaudeAuthRoutes.provider.getOAuthConfig(),
    ).resolves.toEqual({
      clientId: "claude-oauth-client",
      callbackUrl: "https://orch.example.test/api/nodes/claude-auth/callback",
    });
    expect(dependencies.configProvider.requireConfig).toHaveBeenCalledWith(
      "claude_oauth_client_id",
    );
    expect(dependencies.configProvider.requireConfig).toHaveBeenCalledWith(
      "claude_oauth_callback_url",
    );
    expect(
      bundle.nodeClaudeAuthRoutes.pkce.generateChallenge(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(bundle.nodeClaudeAuthRoutes.pkce.generateVerifier()).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(bundle.nodeClaudeAuthRoutes.pkce.generateState()).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    await bundle.nodeClaudeAuthRoutes.sessionStore.create("state-live", "verifier-live", {
      metadata: { node_id: "node-claude" },
    });
    expect(await bundle.nodeClaudeAuthRoutes.sessionStore.pop("state-live")).toEqual({
      verifier: "verifier-live",
      metadata: { node_id: "node-claude" },
    });
    expect(bundle.nodeClaudeAuthRoutes.tokenExchange).toEqual(expect.any(Function));
    runtimeServices.registry.registerNode({
      type: "node_register",
      node_id: "node-agent",
      host: "127.0.0.1",
      port: 4105,
      agents: [{ id: "agent-a", name: "Agent A", backend: "codex" }],
    });
    await expect(
      bundle.nodeAgentProfileRoutes.provider.listAgentProfiles("node-agent"),
    ).resolves.toEqual({
      "agent-a": {
        name: "Agent A",
        portrait_url: undefined,
        max_turns: undefined,
        backend: "codex",
      },
    });
    await expect(
      bundle.nodeAgentProfileRoutes.provider.getUserPortrait("node-agent"),
    ).resolves.toMatchObject({ status: "upstream", statusCode: 200 });
    expect(dependencies.nodeHttpClient.requestNode).toHaveBeenCalledWith({
      nodeId: "node-agent",
      method: "GET",
      path: "/api/dashboard/portrait/user",
      responseType: "arrayBuffer",
    });
    expect(bundle.executeProxyRoutes.provider.executeNew).toEqual(expect.any(Function));
    expect(bundle.executeProxyRoutes.provider.executeResume).toEqual(expect.any(Function));
    expect(bundle.runtime).toEqual({
      boardYjsHostProxyRoutes: runtimeServices.routeOptions.boardYjsHostProxyRoutes,
      nodeSnapshotRoutes: runtimeServices.routeOptions.nodeSnapshotRoutes,
      nodeWsRoute: runtimeServices.routeOptions.nodeWsRoute,
      sessionActionCommandRoutes:
        runtimeServices.routeOptions.sessionActionCommandRoutes,
      sessionBackgroundScheduleRoutes:
        runtimeServices.routeOptions.sessionBackgroundScheduleRoutes,
      sessionCommandRoutes: runtimeServices.routeOptions.sessionCommandRoutes,
      sessionSnapshotRoutes: runtimeServices.routeOptions.sessionSnapshotRoutes,
    });
  });
});

function createRuntimeServices(dependencies: LiveProviderDependencies) {
  return createOrchestratorRuntimeServices({
    config,
    loadTaskSnapshot: dependencies.dbCatalogRepository.loadTaskSnapshot,
    sessionHistoryProvider:
      dependencies.dbCatalogRepository.sessionHistoryProvider,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    sseReplayOnlyForTests: true,
  });
}

function createLiveDependencies(): LiveProviderDependencies {
  const sessionHistoryProvider = {
    readViewport: vi.fn(async () => ({})),
    readMessages: vi.fn(async () => [[], null] as [unknown[], string | null]),
    readTimeline: vi.fn(async () => [[], null] as [unknown[], string | null]),
    readTimelineTrace: vi.fn(async () => null),
    readLastEventId: vi.fn(async () => 0),
    streamEventsRaw: vi.fn(() => emptyRawEvents()),
  };

  return {
    authSessionIdentity: {
      resolveCallerIdentity: vi.fn(async () => ({})),
      resolveSessionIdentity: vi.fn(async () => ({})),
    },
    dbCatalogRepository: {
      loadSessionSnapshot: vi.fn(async () => ({ sessions: [] })),
      loadTaskSnapshot: vi.fn(async () => ({ tasks: [] })),
      sessionHistoryProvider,
    },
    nodeHttpClient: {
      boardYjsHostHttpClient: vi.fn(async () => ({ statusCode: 200 })),
      requestNode: vi.fn(async () => ({ statusCode: 200 })),
    },
    fileBlobR2Storage: {
      readObject: vi.fn(async () => new Uint8Array()),
      writeObject: vi.fn(async () => undefined),
      deleteObject: vi.fn(async () => undefined),
    },
    jwtToken: {
      sign: vi.fn(async () => "token"),
      verify: vi.fn(async () => ({})),
    },
    claudeOAuth: {
      buildAuthorizeUrl: vi.fn(async () => "https://auth.example.test"),
      exchangeCode: vi.fn(async () => ({})),
      fetchProfile: vi.fn(async () => ({})),
    },
    pushRepository: {
      register: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    configProvider: {
      getConfig: vi.fn(async () => ({
        node_name: "orch-live",
        google_client_id: "google-client",
        google_client_secret: "google-secret",
        google_callback_url: "/api/auth/google/callback",
        jwt_secret: "jwt-secret",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        environment: "production",
        atom_enabled: true,
        atom_server_url: "https://atom.example.test",
        atom_api_key: "atom-secret",
        atom_root_node_id: "root-node",
        claude_oauth_client_id: "claude-oauth-client",
        claude_oauth_callback_url:
          "https://orch.example.test/api/nodes/claude-auth/callback",
      })),
      requireConfig: vi.fn(async (key: string) => {
        const config: Record<string, unknown> = {
          node_name: "orch-live",
          google_client_id: "google-client",
          google_client_secret: "google-secret",
          google_callback_url: "/api/auth/google/callback",
          jwt_secret: "jwt-secret",
          databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
          environment: "production",
          atom_enabled: true,
          atom_server_url: "https://atom.example.test",
          atom_api_key: "atom-secret",
          atom_root_node_id: "root-node",
          claude_oauth_client_id: "claude-oauth-client",
          claude_oauth_callback_url:
            "https://orch.example.test/api/nodes/claude-auth/callback",
        };
        return config[key];
      }),
    },
    systemPortraitAssets: {
      readSystemPortraitAsset: vi.fn(async () => Buffer.from("system-portrait")),
    },
  };
}

async function* emptyRawEvents() {
}
