import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createLiveOrchestratorProviderBundle,
  createOrchestratorRuntimeServices,
  liveFactoryImplementedProviderPaths,
  liveProviderDependencyCategories,
  liveProviderWiringInventory,
  parseOrchServerConfig,
  type LiveProviderDependencies,
  type NodeConnectionSnapshot,
  type LiveProviderWiringInventoryEntry,
} from "../src/index.js";
import * as attachmentCommitServiceModule from "../src/attachments/attachment_commit_service.js";
import type {
  AttachmentCommitRepository,
  OwnedAttachmentUpload,
} from "../src/attachments/attachment_commit_contract.js";
import type { AttachmentAssetRow } from "../src/attachments/attachment_read_service.js";
import type {
  AttachmentAccessProvider,
  AttachmentNode,
  AttachmentRouteProvider,
  AttachmentTransport,
  AttachmentRouteOptions,
} from "../src/attachments/attachment_routes.js";
import type { UiEventRepository } from "../src/ui-events/ui_event_routes.js";
import { UI_EVENT_COLLECTION_DISABLED } from "../src/ui-events/ui_event_settings.js";
import type { UsageSummaryClaudeAccount } from "../src/usage/provider_usage_wire.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createSessionStatisticsRepositoryProvider() {
  return async () => ({
    read: async () => {
      throw new Error("session statistics fixture must not read");
    },
  });
}

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
  controlAckMetrics: {},
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
    const sessionStatisticsRepositoryProvider = vi.fn(
      createSessionStatisticsRepositoryProvider(),
    );

    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      usageSummaryRoutes: createUsageSummaryRoutes(),
      sessionStatisticsRepositoryProvider,
      uiEventRepository: createInertUiEventRepository(),
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
    expect(bundle.sessionStatisticsRoutes.accessProvider)
      .toBe(bundle.folderRoutes.accessProvider);
    expect(bundle.sessionStatisticsRoutes.folderProvider)
      .toBe(dependencies.dbCatalogRepository.folderRouteProvider);
    expect(sessionStatisticsRepositoryProvider).not.toHaveBeenCalled();
  });

  it("wires the authenticated attachment reader only when read dependencies are supplied", async () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);
    const resolveReadStorage = vi.fn(async () => ({
      storage: { openObject: vi.fn() },
      identity: "test",
      location: { endpoint: "https://r2.example.test", bucket: "attachments" },
    }));
    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      usageSummaryRoutes: createUsageSummaryRoutes(),
      sessionStatisticsRepositoryProvider: createSessionStatisticsRepositoryProvider(),
      uiEventRepository: createInertUiEventRepository(),
      resolveReadStorage,
      readPageAttachmentEvidence: vi.fn(async () => null),
    });
    const reader = bundle.attachmentRoutes.assetRead;
    expect(reader).toBeDefined();
    const token = await bundle.authRoutes.jwt.issueToken({
      email: "attachment@example.com",
      name: "Attachment User",
    });
    const actor = await reader!.resolveActor({
      headers: { cookie: `soul_dashboard_auth=${token}` },
    } as unknown as FastifyRequest);
    await expect(reader!.service.metadata(actor, "attachment-test", { type: "owner" }))
      .resolves.toMatchObject({ upload_status: "committed" });
    expect(resolveReadStorage).not.toHaveBeenCalled();
  });

  it("shares one commit service between user upload, multipart, and agent registration", () => {
    const createCommit = vi.spyOn(
      attachmentCommitServiceModule,
      "createOwnedAttachmentCommitService",
    );
    try {
      const dependencies = createLiveDependencies();
      const runtimeServices = createRuntimeServices(dependencies);
      const resolveAttachmentStorage = vi.fn(async () => null);
      const bundle = createLiveOrchestratorProviderBundle({
        dependencies,
        runtimeServices,
        usageSummaryRoutes: createUsageSummaryRoutes(),
        sessionStatisticsRepositoryProvider: createSessionStatisticsRepositoryProvider(),
        uiEventRepository: createInertUiEventRepository(),
        resolveAttachmentStorage,
        resolveReadStorage: async () => null,
        readPageAttachmentEvidence: async () => null,
        agentAttachmentRegistration: {
          authBearerToken: "test-token",
          environment: "test",
          sql: {} as never,
          resolveAttachmentBinding: resolveAttachmentStorage,
        },
      });
      const routes = bundle.attachmentRoutes as AttachmentRouteOptions;

      expect(createCommit).toHaveBeenCalledTimes(1);
      expect(routes.assetUpload).toBeDefined();
      expect(routes.multipart?.uploads).toBe(routes.assetUpload);
      expect(createCommit.mock.results[0]?.value).toBe(routes.assetUpload?.commits);
    } finally {
      createCommit.mockRestore();
    }
  });

  it("rejects a write binding without the read resolver and page evidence callback", () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);

    expect(() => createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      usageSummaryRoutes: createUsageSummaryRoutes(),
      sessionStatisticsRepositoryProvider: createSessionStatisticsRepositoryProvider(),
      uiEventRepository: createInertUiEventRepository(),
      resolveAttachmentStorage: async () => null,
    })).toThrow(/attachment.*read|read.*attachment/i);
  });

  it("commits a user legacy upload to R2 before warming the worker cache and alias", async () => {
    const harness = createOwnedUploadHarness();
    try {
      const token = await harness.bundle.authRoutes.jwt.issueToken({
        email: "writer@example.com",
        name: "Writer",
      });
      const body = ownedUploadBody({ session_id: "c8f310da-5f36-4c59-a5d1-888e9bcf158d" });
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/attachments/sessions?nodeId=worker-1",
        headers: {
          ...body.headers,
          cookie: `soul_dashboard_auth=${token}`,
        },
        payload: body.payload,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        path: "/incoming/session/photo.png",
        filename: "photo.png",
        size: 4,
        content_type: "image/png",
      });
      expect(harness.events).toEqual([
        "r2-put",
        "r2-verify",
        "commit",
        "cache",
        "alias",
      ]);
    } finally {
      await harness.app.close();
    }
  });

  it("commits id-v1 while its node is offline and keeps service bearer uploads on the worker path", async () => {
    const harness = createOwnedUploadHarness();
    try {
      const token = await harness.bundle.authRoutes.jwt.issueToken({
        email: "writer@example.com",
        name: "Writer",
      });
      const idV1Body = ownedUploadBody({
        session_id: "8a1f4d39-0e92-4c03-87d4-25d78e5b2460",
        folder_id: "folder-a",
      });
      const idV1 = await harness.app.inject({
        method: "POST",
        url: "/api/attachments/sessions?nodeId=offline",
        headers: {
          ...idV1Body.headers,
          cookie: `soul_dashboard_auth=${token}`,
          "x-soulstream-attachment-contract": "id-v1",
        },
        payload: idV1Body.payload,
      });

      expect(idV1.statusCode).toBe(201);
      expect(idV1.headers["x-soulstream-attachment-contract"]).toBe("id-v1");
      expect(idV1.json()).toEqual({
        attachment: expect.objectContaining({ attachment_id: expect.any(String) }),
      });
      expect(harness.getNode).not.toHaveBeenCalled();
      const ownedCommits = harness.insertOwnedPending.mock.calls.length;

      const serviceBody = ownedUploadBody({ session_id: "legacy-service-session" });
      const serviceUpload = await harness.app.inject({
        method: "POST",
        url: "/api/attachments/sessions?nodeId=worker-1",
        headers: {
          ...serviceBody.headers,
          authorization: "Bearer test-token",
        },
        payload: serviceBody.payload,
      });

      expect(serviceUpload.statusCode).toBe(201);
      expect(serviceUpload.json()).toMatchObject({ path: "/incoming/session/photo.png" });
      expect(harness.insertOwnedPending).toHaveBeenCalledTimes(ownedCommits);
    } finally {
      await harness.app.close();
    }
  });

  it("keeps page attachment reads authenticated and checks the stored page reference", async () => {
    let hasStoredRef = false;
    const readPageAttachmentEvidence = vi.fn(async (pageId: string, attachmentId: string) => ({
      scope: { type: "page" as const, id: pageId },
      folderId: null,
      hasStoredRef: hasStoredRef && attachmentId === "attachment-test",
    }));
    const harness = createOwnedUploadHarness({ readPageAttachmentEvidence });
    try {
      const routes = harness.bundle.attachmentRoutes as AttachmentRouteOptions;
      expect(routes.assetRead).toBeDefined();
      expect(routes.multipart?.uploads).toBe(routes.assetUpload);

      const anonymous = await harness.app.inject({
        method: "GET",
        url: "/api/attachments/attachment-test?context_type=page&context_id=page-1",
      });
      expect(anonymous.statusCode).toBe(401);

      const token = await harness.bundle.authRoutes.jwt.issueToken({
        email: "reader@example.com",
        name: "Reader",
      });
      const request = {
        method: "GET" as const,
        url: "/api/attachments/attachment-test?context_type=page&context_id=page-1",
        headers: { cookie: `soul_dashboard_auth=${token}` },
      };
      expect((await harness.app.inject(request)).statusCode).toBe(403);
      hasStoredRef = true;
      const readable = await harness.app.inject(request);

      expect(readable.statusCode).toBe(200);
      expect(readable.json()).toMatchObject({
        descriptor: { attachment_id: "attachment-test" },
        upload_status: "committed",
      });
      expect(readPageAttachmentEvidence).toHaveBeenLastCalledWith(
        "page-1",
        "attachment-test",
      );
    } finally {
      await harness.app.close();
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
      usageSummaryRoutes: createUsageSummaryRoutes(),
      sessionStatisticsRepositoryProvider: createSessionStatisticsRepositoryProvider(),
      uiEventRepository: createInertUiEventRepository(),
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
      bundle.cogitoRoutes.searchProvider.search({
        q: "hello",
        top_k: 2,
        search_session_id: false,
        include_turn_summaries: false,
        include_highlight: false,
        include_story: false,
      }),
    ).resolves.toEqual({ results: [], navigation_results: [] });
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
    const routeIdentityRequest = {
      headers: { cookie: `soul_dashboard_auth=${pushJwt}` },
    } as unknown as FastifyRequest;
    await expect(
      bundle.folderRoutes.resolveDashboardUserId?.(routeIdentityRequest),
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
      folders: [{ id: "folder-a", name: "Folder A" }],
      sessions_delta: {},
      board_items_delta: {},
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
    expect(bundle.sessionCatalogRoutes.provider).not.toBe(
      dependencies.dbCatalogRepository.sessionCatalogProvider,
    );
    await bundle.sessionCatalogRoutes.provider.renameSession("session-a", "Renamed");
    expect(
      dependencies.dbCatalogRepository.sessionCatalogProvider.renameSession,
    ).toHaveBeenCalledWith("session-a", "Renamed", undefined);
    expect(runtimeServices.sessionBroadcaster.bufferedEvents.at(-1)?.payload).toEqual({
      type: "catalog_updated",
      folders: [{ id: "folder-a", name: "Folder A" }],
      sessions_delta: {
        "session-a": { folderId: "folder-a" },
      },
      board_items_delta: {},
    });
    expect(bundle.sessionCatalogRoutes.accessProvider).toMatchObject({
      requireSessionAccess: expect.any(Function),
      requireFolderAccess: expect.any(Function),
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
      sessionActionCommandRoutes: {
        ...runtimeServices.routeOptions.sessionActionCommandRoutes,
        reviewAcknowledgeFallback: expect.any(Object),
        resolveCallerInfo: expect.any(Function),
      },
      sessionBackgroundScheduleRoutes:
        runtimeServices.routeOptions.sessionBackgroundScheduleRoutes,
      sessionCommandRoutes: {
        ...runtimeServices.routeOptions.sessionCommandRoutes,
        createSessionLifecycle: expect.any(Object),
        modelPresetAvailability: expect.any(Object),
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
    });
  });

  it("injects the shared preset availability service into the execute provider", async () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);
    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      usageSummaryRoutes: createUsageSummaryRoutes(),
      sessionStatisticsRepositoryProvider: createSessionStatisticsRepositoryProvider(),
      uiEventRepository: createInertUiEventRepository(),
    });
    runtimeServices.registry.registerNode({
      type: "node_register",
      node_id: "node-hybrid",
      host: "127.0.0.1",
      port: 4105,
      agents: [{ id: "base-agent", backend: "claude" }],
      capabilities: { max_concurrent: 8, runner_inventory_v1: true },
      supported_backends: ["claude", "codex"],
      model_presets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: false,
        reason: "env_unresolved",
        usage_provider: "codex",
      }],
    });
    runtimeServices.registry.receiveNodeMessage("node-hybrid", {
      type: "runner_inventory",
      running_session_ids: [],
    });

    await expect(bundle.executeProxyRoutes.provider.executeNew({
      prompt: "hello",
      profile: "base-agent",
      model_preset: "codex-5.6-sol",
      caller_info: { source: "execute-proxy" },
    })).rejects.toMatchObject({
      statusCode: 400,
      detail: {
        error: {
          code: "MODEL_PRESET_UNAVAILABLE",
          message: expect.stringContaining("키 미설정"),
        },
      },
    });
    expect(runtimeServices.registry.getConnectedNode("node-hybrid")).toMatchObject({
      pendingCommandCount: 0,
    });
  });
});

function createInertUiEventRepository(): UiEventRepository {
  return {
    readConfig: async () => UI_EVENT_COLLECTION_DISABLED,
    insertBatch: async () => [],
    query: async () => [],
    listInstalls: async () => [],
    pruneExpired: async () => 0,
  };
}

function createUsageSummaryRoutes() {
  return {
    service: {
      getSummary: () => ({
        generatedAt: "2026-07-20T10:00:00.000Z",
        collectedAt: null,
        nodes: [],
      }),
      getLimitRejection: () => null,
      getClaudePoolAccountsForAvailability: (_nodeId: string, accounts: readonly UsageSummaryClaudeAccount[]) => accounts,
    },
  };
}

function createRuntimeServices(dependencies: LiveProviderDependencies) {
  return createOrchestratorRuntimeServices({
    config,
    loadSessionSnapshot: async () => dependencies.dbCatalogRepository.loadSessionSnapshot(),
    sessionHistoryProvider:
      dependencies.dbCatalogRepository.sessionHistoryProvider,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    sseReplayOnlyForTests: true,
  });
}

function createOwnedUploadHarness(options: {
  readPageAttachmentEvidence?: (
    pageId: string,
    attachmentId: string,
  ) => Promise<{ scope: { type: "page"; id: string }; folderId: string | null; hasStoredRef: boolean } | null>;
} = {}) {
  const events: string[] = [];
  let upload: OwnedAttachmentUpload | null = null;
  let storedObject = Buffer.alloc(0);
  const insertOwnedPending = vi.fn(async (input: Parameters<AttachmentCommitRepository["insertOwnedPending"]>[0]) => {
    upload = {
      attachmentId: input.attachmentId,
      storageKey: input.storageKey,
      owner: input.owner,
      registration: input.registration,
      originalName: input.originalName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      storageEndpoint: input.location.endpoint,
      storageBucket: input.location.bucket,
      checksumSha256: null,
      uploadStatus: "pending" as const,
      multipartUploadId: null,
      createdAt: new Date(),
      garbageCollectedAt: null,
    };
    return upload;
  });
  const commitRepository: AttachmentCommitRepository = {
    insertOwnedPending,
    getOwnedUpload: vi.fn(async (attachmentId, owner) => {
      const current = upload;
      return current !== null && current.attachmentId === attachmentId && current.owner.kind === owner.kind && current.owner.key === owner.key
        ? current
        : null;
    }),
    setMultipartUploadId: vi.fn(async () => null),
    commitVerified: vi.fn(async ({ checksumSha256 }) => {
      if (upload === null) return null;
      upload = { ...upload, checksumSha256, uploadStatus: "committed" };
      events.push("commit");
      return upload;
    }),
    clearPendingMultipart: vi.fn(async () => false),
    findLegacyAliasForAsset: vi.fn(async () => null),
    findLegacyAliasForUpload: vi.fn(async () => null),
    insertLegacyAlias: vi.fn(async (input) => {
      events.push("alias");
      return { ...input, availability: "resolved" as const };
    }),
  };
  const storage = {
    putObject: vi.fn(async ({ body }: { body: Uint8Array }) => {
      storedObject = Buffer.from(body);
      events.push("r2-put");
    }),
    openObject: vi.fn(async () => {
      events.push("r2-verify");
      return new Response(storedObject, {
        status: 200,
        headers: { "content-length": String(storedObject.length) },
      });
    }),
  };
  const binding = {
    storage,
    identity: "attachment-r2-test",
    location: { endpoint: "https://r2.example.test", bucket: "attachments" },
  };
  const baseDependencies = createLiveDependencies();
  const dependencies: LiveProviderDependencies = {
    ...baseDependencies,
    dbCatalogRepository: {
      ...baseDependencies.dbCatalogRepository,
      attachmentCommitRepository: commitRepository,
      attachmentReadRepository: {
        ...baseDependencies.dbCatalogRepository.attachmentReadRepository,
        getAsset: vi.fn(async (id): Promise<AttachmentAssetRow | null> => {
          const current = upload;
          if (current !== null && current.attachmentId === id) {
            return {
              id,
              storageKey: current.storageKey,
              storagePurpose: "attachment",
              storageEndpoint: current.storageEndpoint,
              storageBucket: current.storageBucket,
              ownerKind: current.owner.kind,
              ownerKey: current.owner.key,
              registrationScope: current.registration.registrationScope,
              sourceSessionId: current.registration.sourceSessionId,
              originalName: current.originalName,
              mimeType: current.mimeType,
              byteSize: current.byteSize,
              width: null,
              height: null,
              checksumSha256: current.checksumSha256,
              uploadStatus: current.uploadStatus,
            };
          }
          if (id !== "attachment-test") return null;
          return {
            id,
            storageKey: "private/object",
            storagePurpose: "attachment",
            storageEndpoint: "https://r2.example.test",
            storageBucket: "attachments",
            ownerKind: "user_email",
            ownerKey: "attachment@example.com",
            registrationScope: null,
            sourceSessionId: null,
            originalName: "readme.txt",
            mimeType: "text/plain",
            byteSize: 4,
            width: null,
            height: null,
            checksumSha256: null,
            uploadStatus: "committed",
          };
        }),
      },
      adminUsersRepository: {
        ...baseDependencies.dbCatalogRepository.adminUsersRepository,
        findUserByEmail: vi.fn(async (email) => email === "writer@example.com"
          ? { email, isAdmin: false, allowedFolderIds: ["folder-a"] }
          : null),
      },
      sessionResourceAccessRepository: {
        ...baseDependencies.dbCatalogRepository.sessionResourceAccessRepository,
        getSessionAccessRecord: vi.fn(async () => null),
        listFoldersForAccess: vi.fn(async () => [{ id: "folder-a" }]),
      },
    },
  };
  const runtimeServices = createRuntimeServices(dependencies);
  const resolveAttachmentStorage = vi.fn(async () => binding as never);
  const resolveReadStorage = vi.fn(async () => binding as never);
  const readPageAttachmentEvidence = options.readPageAttachmentEvidence ?? (async () => null);
  const bundle = createLiveOrchestratorProviderBundle({
    dependencies,
    runtimeServices,
    usageSummaryRoutes: createUsageSummaryRoutes(),
    sessionStatisticsRepositoryProvider: createSessionStatisticsRepositoryProvider(),
    uiEventRepository: createInertUiEventRepository(),
    resolveAttachmentStorage,
    resolveReadStorage,
    readPageAttachmentEvidence,
  });
  const node: AttachmentNode = { id: "worker-1", host: "127.0.0.1", port: 4105 };
  const getNode = vi.fn(async (nodeId: string) => nodeId === "offline" ? null : node);
  const accessProvider: AttachmentAccessProvider = {
    async resolveAccess() { return { restricted: false }; },
    async requireSessionAccess() {},
  };
  const transport: AttachmentTransport = {
    async uploadAttachment(_node, input) {
      for await (const _chunk of input.chunks) void _chunk;
      events.push("cache");
      return {
        path: "/incoming/session/photo.png",
        filename: input.filename,
        size: input.expectedSize ?? 4,
        content_type: input.contentType,
      };
    },
    async legacyUploadAttachment() { throw new Error("unused"); },
    async deleteSessionAttachments() { return {}; },
    async downloadAttachment() { return {}; },
  };
  const app = createApp({
    config,
    attachmentRoutes: {
      ...bundle.attachmentRoutes,
      provider: { getNode },
      accessProvider,
      transport,
    } as AttachmentRouteOptions,
  });
  return { app, bundle, events, getNode, commitRepository, insertOwnedPending };
}

function ownedUploadBody(fields: Record<string, string>) {
  const boundary = "----factory-owned-upload-test";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(Buffer.from("data"));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

function createLiveDependencies(): LiveProviderDependencies {
  const sessionHistoryProvider = {
    readViewport: vi.fn(async () => ({})),
    readMessages: vi.fn(async () => [[], null] as [unknown[], string | null]),
    readConversationContext: vi.fn(async (sessionId: string) => ({
      session_id: sessionId,
      anchor: "latest_conversation" as const,
      match_event_id: null,
      match_turn_number: null,
      turns: [],
    })),
    readTimeline: vi.fn(async () => [[], null] as [unknown[], string | null]),
    readTimelineTrace: vi.fn(async () => null),
    readStory: vi.fn(async () => ({
      highlight: null,
      narrative: null,
      unfolded_turn_summaries: [],
      narrative_through_event_id: null,
      fold_count: 0,
      updated_at: null,
    })),
    readTurnSummaries: vi.fn(async (sessionId: string) => ({
      session_id: sessionId,
      mode: "count" as const,
      total_count: 0,
      digested_count: 0,
      undigested_count: 0,
    })),
    readLastEventId: vi.fn(async () => 0),
    readEvent: vi.fn(async () => null),
    streamEventsRaw: vi.fn(() => emptyRawEvents()),
  };
  return {
    dbCatalogRepository: {
      agentProfileRepository: {
        snapshot: vi.fn(() => []),
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        put: vi.fn(),
        delete: vi.fn(),
        getPortrait: vi.fn(async () => null),
        putPortrait: vi.fn(),
        deletePortrait: vi.fn(),
      },
      contextBundleRepository: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        put: vi.fn(),
        delete: vi.fn(async () => false),
      },
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
        getSessionReviewPolicy: vi.fn(async () => ({
          key: "session_review_policy" as const,
          sourceAllowlist: ["slack"],
          version: 1,
          updatedAt: "2026-09-14T00:00:00.000Z",
          updatedBy: "migration:test",
        })),
        updateSessionReviewPolicy: vi.fn(async (input) => ({
          key: "session_review_policy" as const,
          sourceAllowlist: input.sourceAllowlist.map(String),
          version: input.expectedVersion + 1,
          updatedAt: "2026-09-14T00:00:01.000Z",
          updatedBy: input.updatedBy,
        })),
      },
      folderRouteProvider: {
        listFolders: vi.fn(async () => [{ id: "folder-a", name: "Folder A" }]),
        listSessionAssignments: vi.fn(async () => ({
          "session-a": { folderId: "folder-a" },
        })),
        listSessionAssignmentsByIds: vi.fn(async (sessionIds: readonly string[]) =>
          Object.fromEntries(sessionIds.map((sessionId) => [
            sessionId,
            { folderId: "folder-a" },
          ]))),

        listBoardItemIdsForSessionDeletion: vi.fn(async () => []),
      } as never,
      folderCountsProvider: {} as never,
      boardAssetRouteProvider: {
        listFolders: vi.fn(async () => []),
        getCatalogSnapshot: vi.fn(async () => ({ boardItems: [] })),
        initFileAsset: vi.fn(async () => ({ assetId: "asset-live" })),
        commitFileAsset: vi.fn(async () => ({ asset: {}, boardItem: {} })),
      },
      attachmentReadRepository: {
        getAsset: vi.fn(async (id: string) => id === "attachment-test" ? {
          id,
          storageKey: "private/object",
          storagePurpose: "attachment",
          storageEndpoint: "https://r2.example.test",
          storageBucket: "attachments",
          ownerKind: "user_email",
          ownerKey: "attachment@example.com",
          registrationScope: null,
          sourceSessionId: null,
          originalName: "readme.txt",
          mimeType: "text/plain",
          byteSize: 4,
          width: null,
          height: null,
          checksumSha256: null,
          uploadStatus: "committed" as const,
        } : null),
        getLegacyAlias: vi.fn(async () => null),
        getSqlScopeEvidence: vi.fn(async () => null),
        listLegacyCandidateScopes: vi.fn(async () => []),
      },
      attachmentCommitRepository: {
        insertOwnedPending: vi.fn(async () => null),
        getOwnedUpload: vi.fn(async () => null),
        setMultipartUploadId: vi.fn(async () => null),
        commitVerified: vi.fn(async () => null),
        clearPendingMultipart: vi.fn(async () => false),
        findLegacyAliasForAsset: vi.fn(async () => null),
        findLegacyAliasForUpload: vi.fn(async () => null),
        insertLegacyAlias: vi.fn(async () => null),
      },
      boardItemRouteProvider: {} as never, markdownDocumentRouteProvider: {} as never,
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
      sessionHistoryProvider,
      cogitoSearchProvider: {
        search: vi.fn(async () => ({ results: [], navigation_results: [] })),
      },
      sessionResourceAccessRepository: {
        getSessionAccessRecord: vi.fn(async () => null),
        listFoldersForAccess: vi.fn(async () => []),
      },
      sessionReviewRepository: {
        acknowledgeSessionReview: vi.fn(async () => ({
          outcome: "not_found" as const,
          session: null,
        })),
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
    },
    nodeHttpClient: {
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
