import assert from "node:assert/strict";

import Fastify from "fastify";

import { runPlaywrightLifecycle } from "../../../unified-dashboard/e2e/playwright-lifecycle-harness.mjs";
import { PageRepository } from "../../src/page/page_repository.js";
import { PageYjsService } from "../../src/page/page_service.js";
import { PlannerRepository } from "../../src/planner/planner_repository.js";
import { registerPlannerRoutes } from "../../src/planner/planner_routes.js";
import { registerRunbookCreateRoute } from "../../src/runbooks/runbook_create_route.js";
import { registerRunbookTaskIdentityHostRoute } from "../../src/runbooks/runbook_task_identity_host_route.js";
import type {
  RunbookTaskIdentityBoardApplication,
  RunbookTaskIdentityBoardPort,
} from "../../src/runbooks/runbook_task_identity_service.js";
import { RunbookTaskIdentityService } from "../../src/runbooks/runbook_task_identity_service.js";
import { SqlRunbookTaskIdentityRepository } from "../../src/runbooks/runbook_task_identity_repository.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import { createPagePostgresHarness } from "../page/page_postgres_harness.js";

interface LocalBrowser {
  close(): Promise<void>;
  newPage(): Promise<LocalPage>;
}

interface LocalPage {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate<TResult, TInput>(
    callback: (input: TInput) => TResult | Promise<TResult>,
    input: TInput,
  ): Promise<TResult>;
}

const folderId = "folder-pr-ae-local";
const projectPageId = "project-pr-ae-local";
const taskId = "00000000-0000-4000-8000-0000000000ae";
const mcpTaskId = "00000000-0000-4000-8000-0000000000af";
const harness = await createPagePostgresHarness();
const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
const pages = new PageYjsService({ repository: new PageRepository(resolver) });
const app = Fastify({ logger: false });

try {
  await harness.sql`INSERT INTO folders (id, name) VALUES (${folderId}, 'PR-AE local')`;
  await harness.sql`INSERT INTO sessions (session_id) VALUES ('pr-ae-mcp-caller')`;
  await pages.createPage({
    page: {
      id: projectPageId,
      title: "PR-AE local",
      dailyDate: null,
      metadata: { folderId },
    },
    actor: { actorKind: "user", actorUserId: "local@example.com" },
    idempotencyKey: "pr-ae:local:create-project",
  });

  const identity = new RunbookTaskIdentityService({
    board: localBoardPort(),
    repository: new SqlRunbookTaskIdentityRepository(resolver),
    createId: identityIdFactory(),
    createOperationId: operationIdFactory(),
    hydratePage: async () => undefined,
  });
  registerRunbookCreateRoute(app, {
    provider: { listFolders: () => [{ id: folderId, name: "PR-AE local" }] },
    accessProvider: { resolveAccess: () => ({ restricted: false }) },
    httpClient: async () => ({ statusCode: 501 }),
    resolveDashboardUserId: () => "local@example.com",
    taskIdentityService: identity,
  });
  registerPlannerRoutes(app, {
    provider: new PlannerRepository(resolver),
    dailyPages: pages,
    resolveUser: async () => ({ email: "local@example.com" }),
  });
  registerRunbookTaskIdentityHostRoute(app, {
    service: identity,
    authBearerToken: "pr-ae-service-token",
  });
  app.get("/", async (_request, reply) => reply.type("text/html").send("<main>PR-AE local stack</main>"));
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const result = await runPlaywrightLifecycle<LocalStackResult, LocalBrowser>({
    lockName: "pr-ae-runbook-task-identity-local-stack",
    timeoutMs: 120_000,
  }, async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const v1 = await page.evaluate(async ({ folderId, projectPageId }) => {
      const created = await fetch("/api/runbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "v1에서 만든 업무",
          folder_id: folderId,
          idempotency_key: "pr-ae-local:v1-create",
        }),
      });
      const identity = await created.json() as TaskIdentityResult;
      const planner = await fetch(`/api/planner/projects/${encodeURIComponent(projectPageId)}`);
      return {
        createStatus: created.status,
        identity,
        plannerStatus: planner.status,
        planner: await planner.json() as LocalStackResult["v1"]["planner"],
      };
    }, { folderId, projectPageId });
    const mcpResponse = await fetch(`${baseUrl}/api/runbook-task-identities/host/create`, {
      method: "POST",
      headers: {
        authorization: "Bearer pr-ae-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actor_kind: "agent",
        actor_session_id: "pr-ae-mcp-caller",
        title: "MCP에서 만든 업무",
        folder_id: folderId,
        idempotency_key: "pr-ae-local:mcp-create",
      }),
    });
    assert.equal(mcpResponse.status, 200);
    const mcp = await mcpResponse.json() as TaskIdentityResult;
    const plannerAfterMcp = await page.evaluate(async (projectPageId) => {
      const response = await fetch(`/api/planner/projects/${encodeURIComponent(projectPageId)}`);
      return {
        status: response.status,
        payload: await response.json() as LocalStackResult["plannerAfterMcp"]["payload"],
      };
    }, projectPageId);
    return { v1, mcp, plannerAfterMcp };
  });

  assert.equal(result.v1.createStatus, 201);
  assert.equal(result.v1.plannerStatus, 200);
  assert.equal(result.v1.identity.id, taskId);
  assert.equal(result.v1.identity.pageId, taskId);
  assert.equal(result.v1.identity.runbookId, taskId);
  assert.equal(result.v1.planner.tasks.items.length, 1);
  assert.equal(result.v1.planner.tasks.items[0]!.page.id, taskId);
  assert.equal(result.v1.planner.tasks.items[0]!.runbook_id, taskId);
  assert.equal(result.mcp.id, mcpTaskId);
  assert.equal(result.mcp.pageId, mcpTaskId);
  assert.equal(result.mcp.runbookId, mcpTaskId);
  assert.equal(result.plannerAfterMcp.status, 200);
  assert.deepEqual(
    result.plannerAfterMcp.payload.tasks.items.map((item: { page: { id: string } }) => item.page.id).sort(),
    [mcpTaskId, taskId].sort(),
  );
  console.log(JSON.stringify({
    ok: true,
    scenario: "v1 POST and soul MCP host create -> v3 planner project",
    ids: [taskId, mcpTaskId],
    residualChromiumProcesses: 0,
  }));
} finally {
  await app.close();
  await pages.close();
  await harness.cleanup();
}

function operationIdFactory(): () => string {
  const ids = [
    "pr-ae-runbook-operation-v1",
    "pr-ae-page-operation-v1",
    "pr-ae-runbook-operation-mcp",
    "pr-ae-page-operation-mcp",
  ];
  return () => ids.shift() ?? `pr-ae-operation-${Date.now()}`;
}

function identityIdFactory(): () => string {
  const ids = [taskId, mcpTaskId];
  return () => ids.shift() ?? "00000000-0000-4000-8000-0000000000ff";
}

interface TaskIdentityResult {
  id: string;
  pageId: string;
  runbookId: string;
}

interface LocalStackResult {
  v1: {
    createStatus: number;
    identity: TaskIdentityResult;
    plannerStatus: number;
    planner: { tasks: { items: Array<{ page: { id: string }; runbook_id: string }> } };
  };
  mcp: TaskIdentityResult;
  plannerAfterMcp: {
    status: number;
    payload: { tasks: { items: Array<{ page: { id: string } }> } };
  };
}

function localBoardPort(): RunbookTaskIdentityBoardPort {
  const boardItems: Array<RunbookTaskIdentityBoardApplication["replica"]["boardItems"][number]> = [];
  return {
    async withRunbookBoardApplication<T>(
      input: Parameters<RunbookTaskIdentityBoardPort["withRunbookBoardApplication"]>[0],
      persist: (application: RunbookTaskIdentityBoardApplication) => Promise<T>,
    ): Promise<T> {
      const next = {
        id: input.boardItemId,
        folderId: input.folderId,
        containerKind: "folder" as const,
        containerId: input.folderId,
        membershipKind: "primary" as const,
        sourceRunbookItemId: null,
        itemType: "runbook" as const,
        itemId: input.runbookId,
        x: input.x,
        y: input.y,
        metadata: { title: input.title, archived: input.archived },
      };
      const existing = boardItems.findIndex((item) => item.id === next.id);
      if (existing >= 0) boardItems.splice(existing, 1, next);
      else boardItems.push(next);
      return await persist({
      documentName: `board-folder:${input.folderId}`,
      scope: {
        folderId: input.folderId,
        containerKind: "folder",
        containerId: input.folderId,
      },
      snapshot: new Uint8Array([1, 2, 3]),
      replica: {
        boardItems: [...boardItems],
        markdownDocuments: [],
      },
      });
    },
    async withRunbookBoardMoveApplication(): Promise<never> {
      throw new Error("not used by this local stack");
    },
  };
}
