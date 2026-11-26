import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  isNodeCredentialRouteAllowed,
  nodeCredentialRouteAllowlist,
  parseOrchServerConfig,
  registerProductionAuthGuard,
  type CreateAppOptions,
} from "../src/index.js";
import type {
  NodeCredentialResolver,
  NodePrincipal,
} from "../src/node_credentials/types.js";

const PRINCIPAL: NodePrincipal = {
  credential_id: "credential-1",
  node_id: "fake-node",
  company_pc: false,
};

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createNodeCredentials() {
  let active = true;
  const resolver: NodeCredentialResolver = {
    resolve: (token) => (active && token === "node-token" ? PRINCIPAL : null),
    onRevoked: () => () => {},
  };
  return {
    resolver,
    revoke: () => {
      active = false;
    },
  };
}

function createGuardedApp() {
  const credentials = createNodeCredentials();
  // Mirrors the live resolver: the shared service bearer passes, and so does an
  // active node credential (that is what the allowlist now narrows).
  const resolveTokenAccess = vi.fn(async (request: {
    headers: { authorization?: string };
  }) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    return token === "service-token"
      || (token !== undefined && credentials.resolver.resolve(token) !== null)
      ? { ok: true as const }
      : { ok: false as const, statusCode: 401, detail: "Authorization header required" };
  });
  const app = Fastify();
  registerProductionAuthGuard(app, {
    resolveTokenAccess,
    nodeCredentials: credentials.resolver,
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/agent-profiles", async () => ({ profiles: [] }));
  app.post("/api/execute", async () => ({ ok: true }));
  app.post("/api/card-orchestration/host/:operation", async () => ({ ok: true }));
  app.post("/api/sessions/:session_id/intervene", async () => ({
    type: "intervene_ack",
    status: "ok",
  }));
  app.post("/api/mcp/host/:tool", async () => ({ ok: true }));
  app.get("/api/nodes/:node_id/model-presets", async () => ({ presets: [] }));
  return { app, credentials, resolveTokenAccess };
}

describe("node credential route allowlist", () => {
  it("denies node credentials on routes outside the node communication surface", async () => {
    const { app, resolveTokenAccess } = createGuardedApp();

    const rejected = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/agent-profiles",
        headers: { authorization: "Bearer node-token" },
      }),
      app.inject({
        method: "POST",
        url: "/api/execute",
        headers: { authorization: "Bearer node-token" },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/api/card-orchestration/host/execute",
        headers: { authorization: "Bearer node-token" },
        payload: {},
      }),
    ]);

    for (const response of rejected) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "NODE_CREDENTIAL_ROUTE_DENIED" });
    }
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    await app.close();
  });

  it("keeps the allowlisted node communication routes working with a node credential", async () => {
    const { app } = createGuardedApp();

    const intervene = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/intervene",
      headers: { authorization: "Bearer node-token" },
      payload: { text: "hello" },
    });
    const mcpHost = await app.inject({
      method: "POST",
      url: "/api/mcp/host/list_sessions",
      headers: { authorization: "Bearer node-token" },
      payload: { args: {}, context: { principal: "internal" } },
    });
    const modelPresets = await app.inject({
      method: "GET",
      url: "/api/nodes/node-1/model-presets",
      headers: { authorization: "Bearer node-token" },
    });

    expect(intervene.statusCode).toBe(200);
    expect(mcpHost.statusCode).toBe(200);
    expect(modelPresets.statusCode).toBe(200);

    await app.close();
  });

  it("leaves shared service tokens, public routes, and invalid tokens unchanged", async () => {
    const { app, credentials } = createGuardedApp();

    const sharedOnUnlisted = await app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: { authorization: "Bearer service-token" },
    });
    expect(sharedOnUnlisted.statusCode).toBe(200);

    const health = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { authorization: "Bearer node-token" },
    });
    expect(health.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: { authorization: "Bearer unknown-token" },
    });
    expect(invalid.statusCode).toBe(401);

    credentials.revoke();
    const revoked = await app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: { authorization: "Bearer node-token" },
    });
    expect(revoked.statusCode).toBe(401);

    await app.close();
  });

  it("matches websocket identities by their protocol method", () => {
    expect(isNodeCredentialRouteAllowed({
      method: "GET",
      routeUrl: "/ws/node",
      websocket: true,
    })).toBe(true);
    expect(isNodeCredentialRouteAllowed({
      method: "GET",
      routeUrl: "/ws/node/control",
      websocket: true,
    })).toBe(true);
    expect(isNodeCredentialRouteAllowed({
      method: "GET",
      routeUrl: "/ws/node",
      websocket: false,
    })).toBe(false);
    expect(isNodeCredentialRouteAllowed({
      method: "POST",
      routeUrl: "/api/sessions/:session_id/intervene",
    })).toBe(true);
    expect(isNodeCredentialRouteAllowed({
      method: "GET",
      routeUrl: "/api/agent-profiles",
    })).toBe(false);
    expect(isNodeCredentialRouteAllowed({
      method: "POST",
      routeUrl: undefined,
    })).toBe(false);
  });

  it("pins every allowlist pattern to a registered orch route", async () => {
    const app = createRouteInventoryApp();
    await app.ready();
    try {
      for (const entry of nodeCredentialRouteAllowlist) {
        const registered = app.hasRoute({
          method: entry.method === "WEBSOCKET" ? "GET" : entry.method,
          url: entry.routeUrl,
        });
        expect(
          registered,
          `${entry.method} ${entry.routeUrl} is not a registered orch route`,
        ).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});

function createRouteInventoryApp() {
  const inert = {} as Record<string, unknown>;
  return createApp({
    config,
    oauthRoutes: { issuer: "https://dashboard.example.test", sql: inert as never },
    agentProfileRoutes: inert,
    ownedAgentRoutes: inert,
    accessLinkRoutes: inert,
    persistentSessionRoutes: { service: inert, reports: inert, requireSessionAccess: async () => undefined },
    conversationRoutes: { service: inert, resolveAccount: async () => "test-account" },
    persistentContextRoutes: { service: inert, authBearerToken: "test-token" },
    adminUsersRoutes: inert,
    r2SettingsRoutes: inert,
    atomRoutes: inert,
    authRoutes: inert,
    attachmentRoutes: { assetRead: inert, multipart: inert },
    agentAttachmentRoutes: { authBearerToken: "test-token", environment: "test", register: inert },
    workerAttachmentRoutes: {
      authBearerToken: "test-token",
      environment: "test",
      service: { metadata: inert, content: inert },
    },
    boardAssetRoutes: inert,
    boardItemRoutes: inert,
    flatFolderContentRoutes: inert,
    cogitoRoutes: inert,
    contextBundleRoutes: inert,
    executeProxyRoutes: inert,
    ephemeralLlmRoutes: inert,
    folderRoutes: {
      ...inert,
      controlPlaneServiceProvider: async () => inert as never,
    },
    mcpHostRoutes: {
      authBearerToken: "test-token",
      folders: { serviceProvider: async () => inert as never, authBearerToken: "test-token" },
    },
    cardDispatchSettingsRoutes: inert,
    cardOrchestrationRoutes: inert,
    cardOrchestrationDecisionRoutes: inert,
    markdownDocumentRoutes: inert,
    nodeAgentProfileRoutes: {
      ...inert,
      modelPresetProvider: {
        listForNode: () => [],
      },
    },
    nodeClaudeAuthRoutes: inert,
    nodeSnapshotRoutes: inert,
    nodePairRoutes: { service: inert },
    nodeReleaseRoutes: {
      authBearerToken: "test-token",
      environment: "test",
      nodeCredentials: null,
      releasesDir: null,
      currentSourceCommit: () => "dev",
    },
    nodeWsRoute: { registry: inert },
    pageYjsRoutes: {
      authBearerToken: "test-token",
      resolveBrowserUser: async () => ({ email: "user@example.com" }),
      browserReads: {
        searchBrowserPages: async () => ({ items: [] }),
        getBrowserBacklinks: async () => ({ items: [], nextCursor: null }),
      },
      plannerReads: {
        getToday: async () => null,
        getFolder: async () => null,
      },
      starredFolderOrder: { moveStarredFolder: async () => ({ pageVersion: 1, changed: false }) },
      onPageUpdated: () => undefined,
      createService: () => ({
        createPage: async () => inert,
        mutatePage: async () => inert,
        close: async () => undefined,
      } as never),
    },
    persistenceHostRoutes: {
      repositoryProvider: async () => inert as never,
      authBearerToken: "test-token",
      nodeCredentials: null,
    },
    scheduleHostRoutes: {
      repositoryProvider: async () => inert as never,
      authBearerToken: "test-token",
      nodeCredentials: null,
    },
    publicStatusRoutes: inert,
    pushRoutes: inert,
    recurringJobRoutes: {
      service: inert,
      resolveActor: async () => null,
    },
    sessionActionCommandRoutes: inert,
    sessionBackgroundScheduleRoutes: inert,
    sessionResumeAfterLimitRoutes: inert,
    sessionCatalogRoutes: inert,
    sessionCommandRoutes: inert,
    sessionHistoryRoutes: { provider: { readConversation: async () => null } },
    sessionSnapshotRoutes: inert,
    sseReplayRoutes: inert,
    systemConfigRoutes: inert,
    userBackgroundRoutes: inert,
    userPreferencesRoutes: inert,
    usageSummaryRoutes: inert,
    sessionStatisticsRoutes: inert,
    uiEventRoutes: inert,
  } as unknown as CreateAppOptions);
}
