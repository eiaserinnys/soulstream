import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveOrchestratorProviderBundle,
  createOrchestratorRuntimeServices,
  liveFactoryImplementedProviderPaths,
  liveProviderDependencyCategories,
  liveProviderWiringInventory,
  parseOrchServerConfig,
  type LiveProviderDependencies,
  type NodeConnectionSnapshot,
  type LiveProviderWiringInventoryEntry,
  type TaskMutationResponse,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const liveProviderConfig: Record<string, unknown> = {
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
    lastPingAtMs: undefined,
    lastPongAtMs: undefined,
  },
  pendingCommandCount: 0,
};

describe("live provider factory boundary", () => {
  it("requires explicit dependency categories for live wiring", () => {
    const dependencies = createLiveDependencies();

    expect(liveProviderDependencyCategories).toEqual([
      "dbCatalogRepository",
      "nodeHttpClient",
      "pushRepository",
      "configProvider",
      "systemPortraitAssets",
    ]);
    expect(Object.keys(dependencies).sort()).toEqual(
      [...liveProviderDependencyCategories].sort(),
    );
  });

  it("returns the default bundle after the inventory reaches fully implemented", () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);

    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
    });

    expect(bundle.implementedProviderPaths).toEqual(
      liveFactoryImplementedProviderPaths,
    );
    expect(bundle.attachmentRoutes.transport).toMatchObject({
      uploadAttachment: expect.any(Function),
      legacyUploadAttachment: expect.any(Function),
      deleteSessionAttachments: expect.any(Function),
      downloadAttachment: expect.any(Function),
    });
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
    expect(bundle.atomRoutes.configProvider).toBe(
      bundle.configProviders.atomRoutes.configProvider,
    );
    expect(bundle.atomRoutes.httpClient.get).toEqual(expect.any(Function));
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
    expect(bundle.pushRoutes.repository).toBe(dependencies.pushRepository);
    expect(bundle.pushRoutes.resolveJwtUser).toEqual(expect.any(Function));
    const pushJwt = await bundle.authRoutes.jwt.issueToken({
      email: "push@example.com",
      name: "Push User",
    });
    await expect(
      bundle.pushRoutes.resolveJwtUser({
        headers: { cookie: `soul_dashboard_auth=${pushJwt}` },
      } as unknown as FastifyRequest),
    ).resolves.toMatchObject({ email: "push@example.com", name: "Push User" });
    expect(bundle.userPreferencesRoutes.repository).toBe(
      dependencies.dbCatalogRepository.userPreferencesRepository,
    );
    await expect(
      bundle.userPreferencesRoutes.resolveAuthenticatedEmail({
        headers: { cookie: `soul_dashboard_auth=${pushJwt}` },
      } as unknown as FastifyRequest),
    ).resolves.toBe("push@example.com");
    expect(bundle.userBackgroundRoutes.repository).toBe(
      dependencies.dbCatalogRepository.userPreferencesRepository,
    );
    await expect(
      bundle.userBackgroundRoutes.resolveAuthenticatedEmail({
        headers: { cookie: `soul_dashboard_auth=${pushJwt}` },
      } as unknown as FastifyRequest),
    ).resolves.toBe("push@example.com");
    await expect(
      bundle.adminUsersRoutes.provider.currentEmail({
        headers: { cookie: `soul_dashboard_auth=${pushJwt}` },
      } as unknown as FastifyRequest),
    ).resolves.toBe("push@example.com");
    await expect(
      bundle.adminUsersRoutes.provider.isAdminEmail("admin@example.com"),
    ).resolves.toBe(true);
    expect(
      dependencies.dbCatalogRepository.adminUsersRepository.findUserByEmail,
    ).toHaveBeenCalledWith("admin@example.com");
    await expect(bundle.adminUsersRoutes.provider.listUsers()).resolves.toEqual([
      expect.objectContaining({ email: "admin@example.com", isAdmin: true }),
    ]);
    await bundle.adminUsersRoutes.provider.broadcastAccessChange();
    expect(runtimeServices.sessionBroadcaster.bufferedEvents.at(-1)?.payload).toEqual({
      type: "catalog_updated",
      catalog: {
        folders: [{ id: "folder-a", name: "Folder A" }],
        sessions: { "session-a": { folderId: "folder-a" } },
      },
    });
    expect(bundle.folderRoutes.accessProvider.resolveAccess).toEqual(expect.any(Function));
    expect(bundle.attachmentRoutes.accessProvider.resolveAccess).toBe(
      bundle.folderRoutes.accessProvider.resolveAccess,
    );
    expect(bundle.attachmentRoutes.accessProvider.requireSessionAccess).toBe(
      bundle.sessionCatalogRoutes.accessProvider?.requireSessionAccess,
    );
    expect(bundle.attachmentRoutes.transport.uploadAttachment).toEqual(
      expect.any(Function),
    );
    expect(await bundle.attachmentRoutes.provider.getNode("missing-attachment-node"))
      .toBeNull();
    expect(bundle.boardAssetRoutes.accessProvider.resolveAccess).toEqual(expect.any(Function));
    expect(bundle.boardAssetRoutes.provider.initFileAsset).toBe(
      dependencies.dbCatalogRepository.boardAssetRouteProvider.initFileAsset,
    );
    expect(bundle.boardItemRoutes).toMatchObject({ provider: dependencies.dbCatalogRepository.boardItemRouteProvider, accessProvider: { resolveAccess: expect.any(Function) } });
    expect(bundle.markdownDocumentRoutes).toMatchObject({ provider: dependencies.dbCatalogRepository.markdownDocumentRouteProvider, accessProvider: { resolveAccess: expect.any(Function) } });
    expect(bundle.runbookRoutes).toMatchObject({ provider: dependencies.dbCatalogRepository.runbookRouteProvider, accessProvider: { resolveAccess: expect.any(Function) } });
    expect(bundle.sessionCatalogRoutes.provider).not.toBe(
      dependencies.dbCatalogRepository.sessionCatalogProvider,
    );
    await bundle.sessionCatalogRoutes.provider.renameSession("session-a", "Renamed");
    expect(
      dependencies.dbCatalogRepository.sessionCatalogProvider.renameSession,
    ).toHaveBeenCalledWith("session-a", "Renamed", undefined);
    expect(runtimeServices.sessionBroadcaster.bufferedEvents.at(-1)?.payload).toEqual({
      type: "catalog_updated",
      catalog: {
        folders: [{ id: "folder-a", name: "Folder A" }],
        sessions: { "session-a": { folderId: "folder-a" } },
      },
    });
    expect(bundle.sessionCatalogRoutes.accessProvider).toMatchObject({
      requireSessionAccess: expect.any(Function),
      requireFolderAccess: expect.any(Function),
    });
    expect(bundle.taskReadRoutes.provider).toBe(
      dependencies.dbCatalogRepository.taskReadProvider,
    );
    await expect(
      bundle.taskMutationRoutes.provider.createTask({
        sessionId: "sess-task",
        title: "Task",
        description: "",
        acceptanceCriteria: "",
        verificationOwner: "agent",
        status: "open",
        setActive: false,
      }),
    ).resolves.toMatchObject({
      task: { id: "task-live" },
      operation: {
        id: "op-live",
        operationType: "create_task_item",
        actorEventId: 9,
      },
      eventId: 9,
    });
    expect(runtimeServices.taskBroadcaster.bufferedEvents.at(-1)?.payload).toEqual({
      type: "task_changed",
      change: {
        table: "task_operations",
        action: "UPDATE",
        task_id: "task-live",
        operation_id: "op-live",
        operation_type: "create_task_item",
        actor_event_id: 9,
      },
    });
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
    runtimeServices.registry.registerNode({
      type: "node_register",
      node_id: "node-attachment",
      host: "127.0.0.1",
      port: 4105,
      agents: [],
    });
    await expect(bundle.attachmentRoutes.provider.getNode("node-attachment"))
      .resolves.toMatchObject({
        nodeId: "node-attachment",
        connected: true,
      });
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
    expect(bundle.runtime.sseReplayRoutes.session.loadSnapshot).not.toBe(
      runtimeServices.routeOptions.sseReplayRoutes.session.loadSnapshot,
    );
    expect(bundle.runtime).toEqual({
      boardYjsHostProxyRoutes: runtimeServices.routeOptions.boardYjsHostProxyRoutes,
      nodeSnapshotRoutes: runtimeServices.routeOptions.nodeSnapshotRoutes,
      nodeWsRoute: runtimeServices.routeOptions.nodeWsRoute,
      sessionActionCommandRoutes:
        runtimeServices.routeOptions.sessionActionCommandRoutes,
      sessionBackgroundScheduleRoutes:
        runtimeServices.routeOptions.sessionBackgroundScheduleRoutes,
      sessionCommandRoutes: {
        ...runtimeServices.routeOptions.sessionCommandRoutes,
        createSessionLifecycle: expect.any(Object),
      },
      sessionHistoryRoutes: {
        ...runtimeServices.routeOptions.sessionHistoryRoutes,
        accessProvider: bundle.sessionCatalogRoutes.accessProvider,
      },
      sessionSnapshotRoutes: {
        snapshotService: { listSessions: expect.any(Function) },
      },
      sseReplayRoutes: {
        ...runtimeServices.routeOptions.sseReplayRoutes,
        session: {
          ...runtimeServices.routeOptions.sseReplayRoutes.session,
          filterEvent: expect.any(Function),
          loadSnapshot: expect.any(Function),
        },
      },
      taskChangeListener: expect.any(Object),
    });
  });
});

function createRuntimeServices(dependencies: LiveProviderDependencies) {
  return createOrchestratorRuntimeServices({
    config,
    loadSessionSnapshot: async () => dependencies.dbCatalogRepository.loadSessionSnapshot(),
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
  const taskMutationResponse = {
    task: { id: "task-live", status: "open" },
    operation: {
      id: "op-live",
      taskId: "task-live",
      operationType: "create_task_item",
      actorEventId: 9,
    },
    eventId: 9,
  } satisfies TaskMutationResponse;

  return {
    dbCatalogRepository: {
      adminUsersRepository: {
        findUserByEmail: vi.fn(async (email) =>
          email === "admin@example.com"
            ? { email, isAdmin: true, allowedFolderIds: [] }
            : null
        ),
        listUsers: vi.fn(async () => [{
          email: "admin@example.com",
          displayName: "Admin",
          isAdmin: true,
          allowedFolderIds: [],
          createdAt: "2026-07-10T00:00:00.000Z",
          createdBy: "init_admin",
        }]),
        createUser: vi.fn(async (input) => ({
          ...input,
          displayName: input.displayName ?? null,
          createdAt: "2026-07-10T00:00:00.000Z",
        })),
        updateUser: vi.fn(async (email, update) => ({
          email,
          displayName: update.displayName ?? null,
          isAdmin: update.isAdmin === true,
          allowedFolderIds: update.allowedFolderIds ?? [],
          createdAt: "2026-07-10T00:00:00.000Z",
          createdBy: "init_admin",
        })),
        deleteUser: vi.fn(async () => undefined),
        canRemoveAdmin: vi.fn(async () => true),
      },
      folderRouteProvider: {
        listFolders: vi.fn(async () => [{ id: "folder-a", name: "Folder A" }]),
        listSessionAssignments: vi.fn(async () => ({
          "session-a": { folderId: "folder-a" },
        })),
      } as never,
      folderCountsProvider: {} as never,
      boardAssetRouteProvider: {
        listFolders: vi.fn(async () => []),
        getCatalogSnapshot: vi.fn(async () => ({ boardItems: [] })),
        initFileAsset: vi.fn(async () => ({ assetId: "asset-live" })),
        commitFileAsset: vi.fn(async () => ({ asset: {}, boardItem: {} })),
      },
      boardItemRouteProvider: {} as never, markdownDocumentRouteProvider: {} as never, runbookRouteProvider: {} as never,
      sessionCatalogProvider: {
        renameSession: vi.fn(async () => undefined),
        moveSessionsToFolder: vi.fn(async () => ({ count: 0 })),
        updateSessionCatalog: vi.fn(async () => undefined),
        deleteSession: vi.fn(async () => undefined),
        getSessionCards: vi.fn(async () => []),
        updateReadPosition: vi.fn(async () => undefined),
      },
      loadSessionSnapshot: vi.fn(async () => ({ sessions: [] })),
      listSessionSnapshots: vi.fn(async () => ({
        sessions: [],
        sessionList: [],
        total: 0,
        cursor: null,
        nextCursor: null,
        hasMore: false,
      })),
      loadTaskSnapshot: vi.fn(async () => ({ tasks: [] })),
      sessionHistoryProvider,
      sessionResourceAccessRepository: {
        getSessionAccessRecord: vi.fn(async () => null),
        listFoldersForAccess: vi.fn(async () => []),
      },
      taskReadProvider: {
        listTasks: vi.fn(async () => []),
        getTaskContext: vi.fn(async () => ({
          activeTask: null,
          activeTaskPath: [],
          linkedTasks: [],
        })),
      },
      taskMutationProvider: {
        createTask: vi.fn(async () => taskMutationResponse),
        setTaskStatus: vi.fn(async () => taskMutationResponse),
        updateTask: vi.fn(async () => taskMutationResponse),
        moveTask: vi.fn(async () => taskMutationResponse),
        linkTask: vi.fn(async () => taskMutationResponse),
        holdTask: vi.fn(async () => taskMutationResponse),
        archiveTask: vi.fn(async () => taskMutationResponse),
        pinTask: vi.fn(async () => taskMutationResponse),
        listTaskOperations: vi.fn(async () => []),
        findTaskScopedSession: vi.fn(async () => null),
        getTask: vi.fn(async () => null),
        createTaskScopedChild: vi.fn(async () => taskMutationResponse),
      },
      userPreferencesRepository: {
        get: vi.fn(async () => null),
        put: vi.fn(async (email, prefs) => ({ email, prefs })),
        putBackground: vi.fn(async (email, prefs, input) => ({
          email,
          prefs,
          backgroundBlob: input.blob,
          backgroundMime: input.mime,
        })),
      },
      createTaskChangeListener: vi.fn(() => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        isRunning: vi.fn(() => false),
      })),
    },
    nodeHttpClient: {
      boardYjsHostHttpClient: vi.fn(async () => ({ statusCode: 200 })),
      requestNode: vi.fn(async () => ({ statusCode: 200 })),
    },
    pushRepository: {
      upsertToken: vi.fn(async () => undefined),
      listTokens: vi.fn(async () => []),
      deleteToken: vi.fn(async () => undefined),
    },
    configProvider: {
      getConfig: vi.fn(async () => liveProviderConfig),
      requireConfig: vi.fn(async (key: string) => liveProviderConfig[key]),
    },
    systemPortraitAssets: {
      readSystemPortraitAsset: vi.fn(async () => Buffer.from("system-portrait")),
    },
  };
}

async function* emptyRawEvents() {}
