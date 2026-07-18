import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerPageBrowserRoutes } from "../../src/page/page_browser_routes.js";
import { PageRepository } from "../../src/page/page_repository.js";
import { PageYjsService } from "../../src/page/page_service.js";
import { PlannerRepository } from "../../src/planner/planner_repository.js";
import { registerPlannerRoutes } from "../../src/planner/planner_routes.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page_postgres_harness.js";

describe("v3 project model local-stack PostgreSQL round-trip", () => {
  let harness: PagePostgresHarness;
  let service: PageYjsService;
  let app: ReturnType<typeof Fastify>;
  let baseUrl: string;
  let guidanceId: string;
  let atomId: string;
  let defaultsId: string;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const repository = new PageRepository(resolver);
    service = new PageYjsService({ repository });
    const actor = { actorKind: "user" as const, actorUserId: "pr-t@example.com" };
    const project = await service.createPage({
      page: { id: "project-pr-t", title: "✨ 소울스트림", dailyDate: null, metadata: { folderId: "folder-pr-t" } },
      actor,
      idempotencyKey: "create_page:pr-t:project",
      initialCommand: {
        type: "batch_operations",
        operations: [
          block("guidance", "guidance", "기존 guidance", { enabled: true, scope: "project" }),
          block("atom", "atom_ref", "", { instance: "atom", nodeId: "old", nodeTitle: "기존", depth: 3, titlesOnly: false }),
          block("defaults", "session_defaults", "", { agentId: "old-agent", nodeId: "old-node", scope: "project" }),
        ],
      },
    });
    guidanceId = project.temp_id_mapping.guidance!;
    atomId = project.temp_id_mapping.atom!;
    defaultsId = project.temp_id_mapping.defaults!;
    await service.createPage({
      page: { id: "task-pr-t", title: "별표할 업무", dailyDate: null, metadata: {} },
      actor,
      idempotencyKey: "create_page:pr-t:task",
      initialCommand: {
        type: "batch_operations",
        operations: [block("task", "task_ref", "", { primary: true, taskId: "rb-pr-t" })],
      },
    });

    app = Fastify({ logger: false });
    const resolveUser = async () => ({ email: "pr-t@example.com" });
    registerPageBrowserRoutes(app, { service, reads: repository, resolveUser });
    registerPlannerRoutes(app, {
      provider: new PlannerRepository(resolver),
      dailyPages: service,
      resolveUser,
    });
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await service?.close();
    await harness?.cleanup();
  });

  it("persists task stars and all editable project context blocks through real HTTP", async () => {
    const current = await json(`${baseUrl}/api/pages/project-pr-t`);
    const contextResponse = await fetch(`${baseUrl}/api/pages/project-pr-t/operations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_version: current.page.version,
        expected_state_vector: current.state_vector,
        idempotency_key: "v3-project-context:browser:roundtrip",
        reason: "PR-T local stack round-trip",
        operations: [
          { op: "update_block_text", block_id: guidanceId, text: "저장 왕복 guidance" },
          { op: "update_block_type_and_properties", block_id: atomId, block_type: "atom_ref", properties: { instance: "atom", nodeId: "new-node", nodeTitle: "새 노드", depth: 5, titlesOnly: true } },
          { op: "update_block_type_and_properties", block_id: defaultsId, block_type: "session_defaults", properties: { agentId: "roselin_codex", nodeId: "eiaserinnys", scope: "project" } },
        ],
      }),
    });
    expect(contextResponse.status).toBe(200);

    const task = await json(`${baseUrl}/api/pages/task-pr-t`);
    const starResponse = await fetch(`${baseUrl}/api/pages/task-pr-t/starred`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        starred: true,
        expected_version: task.page.version,
        idempotency_key: "task-star-roundtrip",
        reason: "PR-T local stack round-trip",
      }),
    });
    expect(starResponse.status).toBe(200);

    const persisted = await json(`${baseUrl}/api/pages/project-pr-t`);
    expect(persisted.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: guidanceId, text: "저장 왕복 guidance" }),
      expect.objectContaining({ id: atomId, properties: expect.objectContaining({ nodeId: "new-node", depth: 5, titlesOnly: true }) }),
      expect.objectContaining({ id: defaultsId, properties: expect.objectContaining({ agentId: "roselin_codex", nodeId: "eiaserinnys" }) }),
    ]));
    const starred = await json(`${baseUrl}/api/planner/starred-tasks?limit=50`);
    expect(starred.items.map((page: { id: string }) => page.id)).toEqual(["task-pr-t"]);

    const [databaseState] = await harness.sql<[{ task_starred: boolean; context_blocks: number }]>`
      SELECT
        COALESCE((metadata->>'starred')::boolean, FALSE) AS task_starred,
        (SELECT COUNT(*)::int FROM blocks WHERE page_id = 'project-pr-t' AND block_type IN ('guidance', 'atom_ref', 'session_defaults')) AS context_blocks
      FROM pages WHERE id = 'task-pr-t'
    `;
    expect(databaseState).toEqual({ task_starred: true, context_blocks: 3 });
  }, 30_000);
});

function block(tempId: string, blockType: string, text: string, properties: Record<string, unknown>) {
  return { op: "create_block" as const, tempId, parentId: null, parentTempId: null, afterBlockId: null, afterTempId: null, blockType, text, properties };
}

async function json(url: string): Promise<any> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return await response.json();
}
