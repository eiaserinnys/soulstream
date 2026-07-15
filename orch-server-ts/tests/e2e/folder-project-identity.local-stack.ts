import assert from "node:assert/strict";

import Fastify from "fastify";

import { runPlaywrightLifecycle } from "../../../unified-dashboard/e2e/playwright-lifecycle-harness.mjs";
import { registerFolderRoutes, type FolderRecord } from "../../src/folders/folder_routes.js";
import { SqlFolderProjectIdentityRepository } from "../../src/folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "../../src/folders/folder_project_identity_service.js";
import { PageRepository } from "../../src/page/page_repository.js";
import { PageYjsService } from "../../src/page/page_service.js";
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
  locator(selector: string): {
    first(): { click(): Promise<void> };
  };
  textContent(selector: string): Promise<string | null>;
  waitForFunction<TInput>(
    callback: (input: TInput) => boolean,
    input: TInput,
  ): Promise<unknown>;
}

const v1Id = "00000000-0000-4000-8000-0000000000af";
const mcpId = "00000000-0000-4000-8000-0000000000b0";
const harness = await createPagePostgresHarness();
const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
const pages = new PageYjsService({ repository: new PageRepository(resolver) });
const app = Fastify({ logger: false });

try {
  const ids = [v1Id, mcpId];
  const identity = new FolderProjectIdentityService({
    repository: new SqlFolderProjectIdentityRepository(resolver),
    createId: () => ids.shift() ?? crypto.randomUUID(),
    createOperationId: operationIdFactory(),
    hydratePage: async () => undefined,
  });
  registerFolderRoutes(app, {
    provider: {
      listFolders: async () => await listFolders(),
      listSessionAssignments: () => ({}),
      createFolder: () => { throw new Error("legacy create fallback called"); },
      updateFolder: () => { throw new Error("legacy update fallback called"); },
      deleteFolder: () => { throw new Error("legacy delete fallback called"); },
      reorderFolders: () => undefined,
    },
    accessProvider: { resolveAccess: () => ({ restricted: false }) },
    resolveDashboardUserId: () => "local@example.com",
    projectIdentityService: identity,
    authBearerToken: "pr-af-service-token",
  });
  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId", async (request, reply) => {
    return reply.send(await pages.getBrowserPage(request.params.pageId));
  });
  app.get("/api/v3/projects", async (_request, reply) => {
    const rows = await harness.sql<Array<{
      folder_id: string;
      folder_name: string;
      project_page_id: string;
      page_title: string;
    }>>`
      SELECT f.id AS folder_id, f.name AS folder_name,
             f.project_page_id, p.title AS page_title
      FROM folders f JOIN pages p ON p.id = f.project_page_id
      WHERE f.archived = FALSE AND p.archived = FALSE
      ORDER BY f.name
    `;
    return reply.send({ projects: rows });
  });
  app.get("/", async (_request, reply) => reply.type("text/html").send(projectPageHtml()));
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const result = await runPlaywrightLifecycle<LocalStackResult, LocalBrowser>({
    lockName: "pr-af-folder-project-identity-local-stack",
    timeoutMs: 120_000,
  }, async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const v1 = await page.evaluate(async (idempotencyKey) => {
      const response = await fetch("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "v1에서 만든 프로젝트", idempotencyKey }),
      });
      return { status: response.status, folder: await response.json() as IdentityFolder };
    }, "pr-af-local:v1-create");
    assert.equal(v1.status, 201, JSON.stringify(v1));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-page-id="${v1Id}"]`).first().click();
    await page.waitForFunction(
      (pageId) => {
        const dom = globalThis as unknown as {
          document: { querySelector(selector: string): { textContent: string | null } | null };
        };
        return dom.document.querySelector("#opened-page-id")?.textContent === pageId;
      },
      v1Id,
    );
    const openedPageId = await page.textContent("#opened-page-id");

    const mcpResponse = await fetch(
      `${baseUrl}/api/folder-project-identities/host/create`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer pr-af-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "MCP에서 만든 프로젝트",
          actor_kind: "system",
          idempotency_key: "pr-af-local:mcp-create",
        }),
      },
    );
    const mcp = await mcpResponse.json() as { folder: IdentityFolder };
    const projects = await page.evaluate(async (_unused) => {
      const response = await fetch("/api/v3/projects");
      return await response.json() as ProjectsResponse;
    }, null);
    return { v1, openedPageId, mcpStatus: mcpResponse.status, mcp, projects };
  });

  assert.equal(result.v1.status, 201);
  assert.equal(result.v1.folder.id, v1Id);
  assert.equal(result.v1.folder.projectPageId, v1Id);
  assert.equal(result.openedPageId, v1Id);
  assert.equal(result.mcpStatus, 200);
  assert.equal(result.mcp.folder.id, mcpId);
  assert.equal(result.mcp.folder.projectPageId, mcpId);
  assert.deepEqual(
    result.projects.projects.map((project) => project.project_page_id).sort(),
    [v1Id, mcpId].sort(),
  );
  console.log(JSON.stringify({
    ok: true,
    scenario: "v1 and MCP folder create -> v3 projects -> click same-ID page",
    ids: [v1Id, mcpId],
    residualChromiumProcesses: 0,
  }));
} finally {
  await app.close();
  await pages.close();
  await harness.cleanup();
}

async function listFolders(): Promise<FolderRecord[]> {
  const rows = await harness.sql<Array<Record<string, unknown>>>`
    SELECT * FROM folders WHERE archived = FALSE ORDER BY name
  `;
  return rows.map((row) => {
    const projectPageId = typeof row.project_page_id === "string"
      ? row.project_page_id
      : null;
    if (!projectPageId) throw new Error(`folder ${String(row.id)} has no project page identity`);
    return {
      id: String(row.id),
      name: String(row.name),
      sortOrder: Number(row.sort_order),
      settings: recordValue(row.settings),
      parentFolderId: typeof row.parent_folder_id === "string"
        ? row.parent_folder_id
        : null,
      projectPageId,
    };
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function projectPageHtml(): string {
  return `<!doctype html><main><div id="projects"></div><output id="opened-page-id"></output></main>
    <script>
      fetch('/api/v3/projects').then(r => r.json()).then(({ projects }) => {
        const root = document.getElementById('projects');
        for (const project of projects) {
          const button = document.createElement('button');
          button.dataset.pageId = project.project_page_id;
          button.textContent = project.folder_name;
          button.onclick = async () => {
            const result = await fetch('/api/pages/' + encodeURIComponent(project.project_page_id));
            const snapshot = await result.json();
            document.getElementById('opened-page-id').textContent = snapshot.page.id;
          };
          root.appendChild(button);
        }
      });
    </script>`;
}

function operationIdFactory(): () => string {
  let index = 0;
  return () => `pr-af-operation-${index++}`;
}

interface IdentityFolder {
  id: string;
  projectPageId: string;
}

interface ProjectsResponse {
  projects: Array<{ project_page_id: string }>;
}

interface LocalStackResult {
  v1: { status: number; folder: IdentityFolder };
  openedPageId: string | null;
  mcpStatus: number;
  mcp: { folder: IdentityFolder };
  projects: ProjectsResponse;
}
