import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

import { SERVICE_CALLER, isServiceCaller, type ServiceCaller } from "../src/auth/service_caller.js";
import {
  buildProductionRouteOptions,
  createApp,
  createSessionResourceAccessProvider,
  executeSessionIntervention,
  parseOrchServerConfig,
  type LiveOrchestratorProviderBundle,
  type SessionResourceAccessProvider,
} from "../src/index.js";
import type { NodeCredentialResolver } from "../src/node_credentials/types.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const RESTRICTED_COOKIE = "soul_dashboard_auth=restricted-account";
const SERVICE_AUTHORIZATION = "Bearer test-token";

function createAclFixture() {
  const policy = {
    resolveAccess: async (request: FastifyRequest | ServiceCaller) =>
      !isServiceCaller(request)
        && request.headers.cookie?.includes("restricted-account") === true
        ? { restricted: true, allowedFolderIds: ["folder-allowed"] }
        : { restricted: false, allowedFolderIds: [] },
  };
  const repository = {
    getSessionAccessRecord: async (sessionId: string) => ({
      sessionId,
      folderId: sessionId === "sess-allowed" ? "folder-allowed" : "folder-other",
    }),
    listFoldersForAccess: async () => [
      { id: "folder-allowed", parentFolderId: null },
      { id: "folder-other", parentFolderId: null },
    ],
  };
  const accessProvider = createSessionResourceAccessProvider({
    accessProvider: policy,
    repository,
  });
  const routed = { node: { nodeId: "node-1" }, command: { requestId: "req-1" } };
  const routeExistingSessionPendingCommand = vi.fn(async () => routed);
  const respond = vi.fn(async () => routed);
  const sendPendingCommand = vi.fn(async () => ({
    type: "intervene_ack",
    status: "ok",
  }));
  const router = { routeExistingSessionPendingCommand, respond } as never;
  const bridge = { sendPendingCommand } as never;
  return {
    accessProvider,
    router,
    bridge,
    routeExistingSessionPendingCommand,
    respond,
    sendPendingCommand,
  };
}

function createAclApp() {
  const fixture = createAclFixture();
  const app = createApp({
    config,
    sessionActionCommandRoutes: {
      router: fixture.router,
      bridge: fixture.bridge,
      accessProvider: fixture.accessProvider,
    },
    sessionBackgroundScheduleRoutes: {
      router: fixture.router,
      bridge: fixture.bridge,
      accessProvider: fixture.accessProvider,
    },
    sessionCommandRoutes: {
      router: fixture.router,
      bridge: fixture.bridge,
      nodeCredentials: null,
      accessProvider: fixture.accessProvider,
    },
  });
  return { app, ...fixture };
}

const DENIED_ACTION_REQUESTS = [
  ["POST", "/api/sessions/sess-denied/intervene"],
  ["POST", "/api/sessions/sess-denied/message"],
  ["POST", "/api/sessions/sess-denied/interrupt"],
  ["POST", "/api/sessions/sess-denied/review/acknowledge"],
  ["POST", "/api/sessions/sess-denied/tool-approvals/approval-1/approve"],
  ["POST", "/api/sessions/sess-denied/tool-approvals/approval-1/reject"],
  ["POST", "/api/sessions/sess-denied/realtime/call"],
  ["POST", "/api/sessions/sess-denied/realtime/events"],
  ["POST", "/api/sessions/sess-denied/realtime/tool-approvals/approval-1/resolve"],
  ["GET", "/api/sessions/sess-denied/background-tasks"],
  ["GET", "/api/sessions/sess-denied/background-tasks/bg-1/output"],
  ["POST", "/api/sessions/sess-denied/background-tasks/bg-1/stop"],
  ["POST", "/api/sessions/sess-denied/background-tasks/background"],
  ["GET", "/api/sessions/sess-denied/schedules"],
  ["DELETE", "/api/sessions/sess-denied/schedules/sched-1"],
  ["POST", "/api/sessions/sess-denied/respond"],
] as const;

type RouterFixture = ReturnType<typeof createAclFixture>;

const RUNTIME_STUB = {
  routeOptions: { pageYjsRoutes: {} },
  sessionBroadcaster: {},
  registry: {},
  sessionBridge: {},
} as never;

function createProductionProviders(
  accessProvider: SessionResourceAccessProvider,
  fixture: Pick<RouterFixture, "router" | "bridge">,
): LiveOrchestratorProviderBundle {
  return {
    runtime: {
      sessionActionCommandRoutes: { router: fixture.router, bridge: fixture.bridge },
      sessionBackgroundScheduleRoutes: { router: fixture.router, bridge: fixture.bridge },
      sessionCommandRoutes: { router: fixture.router, bridge: fixture.bridge, nodeCredentials: null },
      flatFolderContentRoutes: { host: {} },
      routeOptions: {},
      sessionBridge: {},
      registry: {},
    },
    sessionCatalogRoutes: { accessProvider, provider: {} },
    authRoutes: { resolveTokenAccess: async () => ({ ok: true as const }) },
    authenticatedUserResolvers: { resolveOAuthAccess: async () => null },
    modelPresetAvailability: {},
    modelCatalog: {},
    nodeAgentProfileRoutes: { provider: {} },
    adminUsersRoutes: { provider: { currentEmail: () => null, isAdminEmail: () => false } },
    folderRoutes: { accessProvider: {}, provider: {} },
    configProviders: { publicStatusRoutes: { configProvider: {} } },
  } as unknown as LiveOrchestratorProviderBundle;
}

/**
 * Mirrors the live dashboard access provider: it resolves the user ACL from the
 * body caller_info.email, so a service-token completion notification carrying
 * an unregistered email would be denied without the service-bearer bypass.
 */
function createEmailAclApp() {
  const policy = {
    resolveAccess: async (request: FastifyRequest | ServiceCaller) => {
      if (isServiceCaller(request)) return { restricted: false, allowedFolderIds: [] };
      const email = callerInfoEmail(request);
      if (email === "allowed@example.com") {
        return { restricted: true, allowedFolderIds: ["folder-allowed"] };
      }
      if (email !== null) return { restricted: true, allowedFolderIds: [] };
      return { restricted: false, allowedFolderIds: [] };
    },
  };
  const repository = {
    getSessionAccessRecord: async (sessionId: string) => ({
      sessionId,
      folderId: "folder-other",
    }),
    listFoldersForAccess: async () => [
      { id: "folder-allowed", parentFolderId: null },
      { id: "folder-other", parentFolderId: null },
    ],
  };
  const accessProvider = createSessionResourceAccessProvider({
    accessProvider: policy,
    repository,
  });
  const routed = { node: { nodeId: "node-1" }, command: { requestId: "req-1" } };
  const routeExistingSessionPendingCommand = vi.fn(async () => routed);
  const respond = vi.fn(async () => routed);
  const sendPendingCommand = vi.fn(async () => ({
    type: "intervene_ack",
    status: "ok",
  }));
  const nodeCredentials: NodeCredentialResolver = {
    resolve: (token) => (token === "node-token"
      ? { credential_id: "credential-1", node_id: "node-1", company_pc: false }
      : null),
    onRevoked: () => () => {},
  };
  const options = buildProductionRouteOptions(
    config,
    RUNTIME_STUB,
    createProductionProviders(accessProvider, {
      router: { routeExistingSessionPendingCommand, respond } as never,
      bridge: { sendPendingCommand } as never,
    }),
    async () => ({
      persistentReports: { acceptReply: async () => ({ action: "none" }) },
      deliveries: { register: async () => ({ conflict: false }) },
    }) as never,
    {} as never,
    nodeCredentials,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "test-node",
  );
  const app = createApp({
    config,
    productionAuth: options.productionAuth,
    sessionActionCommandRoutes: options.sessionActionCommandRoutes,
    sessionBackgroundScheduleRoutes: options.sessionBackgroundScheduleRoutes,
    sessionCommandRoutes: options.sessionCommandRoutes,
  });
  return { app, routeExistingSessionPendingCommand, respond };
}

function callerInfoEmail(request: FastifyRequest): string | null {
  const body = request.body as {
    caller_info?: { email?: unknown };
    callerInfo?: { email?: unknown };
  } | undefined;
  const email = body?.caller_info?.email ?? body?.callerInfo?.email;
  return typeof email === "string" ? email : null;
}

describe("session folder ACL on session action, background, and respond routes", () => {
  it("denies a restricted account outside its folders on every guarded route", async () => {
    const { app, routeExistingSessionPendingCommand, respond } = createAclApp();

    for (const [method, url] of DENIED_ACTION_REQUESTS) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie: RESTRICTED_COOKIE },
        ...(method === "GET" || method === "DELETE" ? {} : { payload: { text: "hello" } }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json(), `${method} ${url}`).toMatchObject({
        error: { code: "SESSION_ACCESS_DENIED" },
      });
    }

    expect(routeExistingSessionPendingCommand).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();

    await app.close();
  });

  it("allows a restricted account inside its folders and the service token everywhere", async () => {
    const { app, routeExistingSessionPendingCommand, respond } = createAclApp();

    const intervene = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-allowed/intervene",
      headers: { cookie: RESTRICTED_COOKIE },
      payload: { text: "hello" },
    });
    const interrupt = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-allowed/interrupt",
      headers: { cookie: RESTRICTED_COOKIE },
      payload: {},
    });
    const background = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-allowed/background-tasks",
      headers: { cookie: RESTRICTED_COOKIE },
    });
    const respondAllowed = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-allowed/respond",
      headers: { cookie: RESTRICTED_COOKIE },
      payload: { request_id: "input-1", answers: {} },
    });

    expect(intervene.statusCode).toBe(200);
    expect(interrupt.statusCode).toBe(200);
    expect(background.statusCode).toBe(200);
    expect(respondAllowed.statusCode).toBe(200);

    const serviceIntervene = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/intervene",
      headers: { authorization: SERVICE_AUTHORIZATION },
      payload: { text: "hello" },
    });
    const serviceBackground = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-denied/schedules",
      headers: { authorization: SERVICE_AUTHORIZATION },
    });
    const serviceRespond = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/respond",
      headers: { authorization: SERVICE_AUTHORIZATION },
      payload: { request_id: "input-1", answers: {} },
    });

    expect(serviceIntervene.statusCode).toBe(200);
    expect(serviceBackground.statusCode).toBe(200);
    expect(serviceRespond.statusCode).toBe(200);
    expect(routeExistingSessionPendingCommand).toHaveBeenCalledTimes(5);
    expect(respond).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("does not apply the folder ACL inside the shared intervention body used by MCP", async () => {
    const fixture = createAclFixture();
    const requireSessionAccess = vi.fn(fixture.accessProvider.requireSessionAccess);

    const result = await executeSessionIntervention(
      {
        router: fixture.router,
        bridge: fixture.bridge,
        accessProvider: { ...fixture.accessProvider, requireSessionAccess },
      },
      SERVICE_CALLER,
      "sess-denied",
      { text: "hello" },
    );

    expect(result.status).toBe(200);
    expect(requireSessionAccess).not.toHaveBeenCalled();
    expect(fixture.routeExistingSessionPendingCommand).toHaveBeenCalledTimes(1);
  });

  it("wires the service-bearer bypass wrapper into the three HTTP route option groups", () => {
    const fixture = createAclFixture();
    const runtimeAction = { router: fixture.router, bridge: fixture.bridge };
    const runtimeBackground = { router: fixture.router, bridge: fixture.bridge };
    const runtimeCommand = { router: fixture.router, bridge: fixture.bridge, nodeCredentials: null };
    const providers = {
      ...createProductionProviders(fixture.accessProvider, fixture),
      runtime: {
        sessionActionCommandRoutes: runtimeAction,
        sessionBackgroundScheduleRoutes: runtimeBackground,
        sessionCommandRoutes: runtimeCommand,
        flatFolderContentRoutes: { host: {} },
        routeOptions: {},
        sessionBridge: {},
        registry: {},
      },
    } as unknown as LiveOrchestratorProviderBundle;

    const options = buildProductionRouteOptions(
      config,
      RUNTIME_STUB,
      providers,
      async () => ({}) as never,
      {} as never,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "test-node",
    );

    const guard = options.sessionActionCommandRoutes?.accessProvider;
    expect(guard).toBeDefined();
    expect(guard).not.toBe(fixture.accessProvider);
    expect(options.sessionBackgroundScheduleRoutes?.accessProvider).toBe(guard);
    expect(options.sessionCommandRoutes?.accessProvider).toBe(guard);
    expect(runtimeAction).not.toHaveProperty("accessProvider");
    expect(runtimeBackground).not.toHaveProperty("accessProvider");
    expect(runtimeCommand).not.toHaveProperty("accessProvider");
  });

  it("lets service-token and node-credential callers through with a body email", async () => {
    const { app, routeExistingSessionPendingCommand, respond } = createEmailAclApp();

    const serviceIntervene = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/intervene",
      headers: { authorization: SERVICE_AUTHORIZATION },
      payload: { text: "done", caller_info: { email: "stranger@example.com" } },
    });
    const nodeIntervene = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/intervene",
      headers: { authorization: "Bearer node-token" },
      payload: { text: "done", caller_info: { email: "restricted@example.com" } },
    });
    const serviceInterrupt = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/interrupt",
      headers: { authorization: SERVICE_AUTHORIZATION },
      payload: { caller_info: { email: "stranger@example.com" } },
    });
    const serviceRespond = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/respond",
      headers: { authorization: SERVICE_AUTHORIZATION },
      payload: {
        request_id: "input-1",
        answers: {},
        caller_info: { email: "stranger@example.com" },
      },
    });

    expect(serviceIntervene.statusCode).toBe(200);
    expect(nodeIntervene.statusCode).toBe(200);
    expect(serviceInterrupt.statusCode).toBe(200);
    expect(serviceRespond.statusCode).toBe(200);

    // The same body email without a service identity still goes through the
    // email-derived user ACL (this is the completion-notifier regression).
    const userIntervene = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-denied/intervene",
      headers: { cookie: "soul_dashboard_auth=user-session" },
      payload: { text: "done", caller_info: { email: "stranger@example.com" } },
    });
    expect(userIntervene.statusCode).toBe(403);
    expect(userIntervene.json()).toMatchObject({
      error: { code: "SESSION_ACCESS_DENIED" },
    });

    expect(routeExistingSessionPendingCommand).toHaveBeenCalledTimes(3);
    expect(respond).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
