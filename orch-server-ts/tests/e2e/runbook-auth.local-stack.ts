import assert from "node:assert/strict";

import Fastify from "fastify";

import { runPlaywrightLifecycle } from "../../../unified-dashboard/e2e/playwright-lifecycle-harness.mjs";
import { registerRunbookCreateRoute } from "../../src/runbooks/runbook_create_route.js";
import { createLiveAuthTokenResolver } from "../../src/runtime/live_auth_route_provider.js";
import { createLiveAuthenticatedUserResolvers } from "../../src/runtime/live_authenticated_user_resolver.js";
import { createLiveDashboardAccessProvider } from "../../src/runtime/live_dashboard_access_provider.js";
import { registerProductionAuthGuard } from "../../src/runtime/production_auth_guard.js";
import type { AuthJwtHelper } from "../../src/auth/auth_routes.js";
import type { LiveConfigProviderBoundary } from "../../src/runtime/live_provider_dependencies.js";

interface LocalBrowser {
  close(): Promise<void>;
  newContext(): Promise<LocalBrowserContext>;
}

interface LocalBrowserContext {
  addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>;
  newPage(): Promise<LocalPage>;
}

interface LocalPage {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate<TResult, TInput>(
    callback: (input: TInput) => TResult | Promise<TResult>,
    input: TInput,
  ): Promise<TResult>;
}

const dashboardToken = "valid-dashboard-token";
const dashboardEmail = "dashboard@example.com";
let verificationCount = 0;
const jwt: AuthJwtHelper = {
  issueToken: async () => dashboardToken,
  verifyToken: async (token) => {
    verificationCount += 1;
    return token === dashboardToken ? { email: dashboardEmail, name: "Dashboard" } : null;
  },
};
const configProvider = configWith({
  auth_bearer_token: "service-token",
  environment: "production",
  google_client_id: "google-client",
  jwt_secret: "jwt-secret",
});
const authenticatedUser = createLiveAuthenticatedUserResolvers({ jwt });
const accessProvider = createLiveDashboardAccessProvider({
  configProvider,
  jwt,
  verifyDashboardToken: authenticatedUser.verifyToken,
  repository: {
    findUserByEmail: async (email) => ({
      email,
      isAdmin: true,
      allowedFolderIds: [],
    }),
  },
});
const app = Fastify({ logger: false });
const createdActors: string[] = [];

try {
  registerProductionAuthGuard(app, {
    resolveTokenAccess: createLiveAuthTokenResolver({
      configProvider,
      jwt,
      resolveDashboardUser: authenticatedUser.resolveUser,
    }),
  });
  app.get("/", async (_request, reply) =>
    reply.type("text/html").send("<main>Runbook auth lifecycle</main>"));
  app.get("/api/auth/status", async (request) => ({
    authenticated: await authenticatedUser.resolveUser(request) !== null,
  }));
  registerRunbookCreateRoute(app, {
    provider: { listFolders: () => [{ id: "folder-a", name: "Folder A" }] },
    accessProvider,
    httpClient: async () => ({ statusCode: 501 }),
    resolveDashboardUserId: authenticatedUser.resolveEmail,
    taskIdentityService: {
      create: async (input) => {
        createdActors.push(input.actor.actorUserId ?? "");
        return {
          id: "00000000-0000-4000-8000-0000000000b1",
          pageId: "00000000-0000-4000-8000-0000000000b1",
          runbookId: "00000000-0000-4000-8000-0000000000b1",
          operation: { id: "runbook-operation" },
          pageOperation: { id: "page-operation" },
          pageCommit: {} as never,
          snapshot: { runbook: {}, sections: [], items: [] },
        };
      },
      promoteExistingPage: async () => {
        throw new Error("not used");
      },
      mutateFromRunbook: async () => {
        throw new Error("not used");
      },
      backfillLegacyRunbook: async () => {
        throw new Error("not used");
      },
    },
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const result = await runPlaywrightLifecycle<LifecycleResult, LocalBrowser>({
    lockName: "pr-br-runbook-auth-local-stack",
    timeoutMs: 120_000,
  }, async ({ browser }) => {
    const browserContext = await browser.newContext();
    await browserContext.addCookies([{
      name: "soul_dashboard_auth",
      value: dashboardToken,
      url: baseUrl,
    }]);
    const page = await browserContext.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    return await page.evaluate(async () => {
      const status = await fetch("/api/auth/status");
      const create = await fetch("/api/runbooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Authenticated work",
          folder_id: "folder-a",
          idempotency_key: "pr-br:lifecycle:create",
        }),
      });
      return {
        statusCode: status.status,
        authenticated: (await status.json() as { authenticated: boolean }).authenticated,
        createStatus: create.status,
        createBody: await create.json() as { id?: string; detail?: string },
      };
    }, undefined);
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.authenticated, true);
  assert.equal(result.createStatus, 201);
  assert.equal(result.createBody.id, "00000000-0000-4000-8000-0000000000b1");
  assert.deepEqual(createdActors, [dashboardEmail]);
  assert.equal(verificationCount, 2);
  console.log(JSON.stringify({
    ok: true,
    scenario: "auth status 200 and POST /api/runbooks 201 with one JWT verification per request",
    verificationCount,
    residualChromiumProcesses: 0,
  }));
} finally {
  await accessProvider.close();
  await app.close();
}

interface LifecycleResult {
  statusCode: number;
  authenticated: boolean;
  createStatus: number;
  createBody: { id?: string; detail?: string };
}

function configWith(values: Record<string, unknown>): LiveConfigProviderBoundary {
  return {
    getConfig: async () => values,
    requireConfig: async (key) => {
      if (!(key in values)) throw new Error(`${key} is required`);
      return values[key];
    },
  };
}
