import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PageRepository } from "../src/page/page_repository.js";
import { PageYjsService } from "../src/page/page_service.js";
import { registerTaskCreateRoute } from "../src/tasks/task_create_route.js";
import type {
  TaskIdentityBoardApplication,
  TaskIdentityBoardPort,
} from "../src/tasks/task_identity_service.js";
import { TaskIdentityService } from "../src/tasks/task_identity_service.js";
import { SqlTaskIdentityRepository } from "../src/tasks/task_identity_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

const actor = { actorKind: "user" as const, actorUserId: "user@example.com" };

describe("Task title collision policy", () => {
  let harness: PagePostgresHarness;
  let pages: PageYjsService;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    pages = new PageYjsService({
      repository: new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql })),
    });
  }, 60_000);

  afterAll(async () => {
    await pages?.close();
    await harness?.cleanup();
  });

  it("promotes the canonical standalone page in place and preserves its content and daily mount", async () => {
    const folderId = "folder-title-promote";
    const projectPageId = "project-title-promote";
    const pageId = "page-title-promote";
    const dailyPageId = "daily-title-promote";
    await createProject(folderId, projectPageId, "Title promote project");
    await createPage(pageId, "아리엘라 EA 대사 작업", "기존 본문");
    await createPage(dailyPageId, "PR-CE daily title promote", "[[아리엘라 EA 대사 작업]]", "2026-07-17");

    const service = createService("00000000-0000-4000-8000-0000000000ce");
    const created = await service.create({
      title: "아리엘라 ea 대사 작업",
      description: "재시도 설명으로 덮으면 안 됨",
      folderId,
      actor,
      idempotencyKey: "pr-ce:promote:first",
    });

    expect(created).toMatchObject({ id: pageId, pageId, taskId: pageId, projectPageId });
    const rows = await harness.sql<Array<{
      page_title: string;
      task_title: string;
      body_count: number;
      reference_count: number;
      daily_mount_count: number;
      project_mount_count: number;
      title_page_count: number;
    }>>`
      SELECT page.title AS page_title, task.title AS task_title,
        (SELECT COUNT(*)::int FROM blocks
          WHERE page_id = ${pageId} AND text_plain = '기존 본문') AS body_count,
        (SELECT COUNT(*)::int FROM blocks
          WHERE page_id = ${pageId} AND block_type = 'task_ref'
            AND properties->>'primary' = 'true') AS reference_count,
        (SELECT COUNT(*)::int FROM block_links link
          JOIN blocks source ON source.id = link.source_block_id
          WHERE link.target_page_id = ${pageId} AND source.page_id = ${dailyPageId}) AS daily_mount_count,
        (SELECT COUNT(*)::int FROM block_links link
          JOIN blocks source ON source.id = link.source_block_id
          WHERE link.target_page_id = ${pageId} AND source.page_id = ${projectPageId}) AS project_mount_count,
        (SELECT COUNT(*)::int FROM pages
          WHERE title_key = lower(btrim('아리엘라 EA 대사 작업'))) AS title_page_count
      FROM pages page
      JOIN tasks task ON task.task_page_id = page.id
      WHERE page.id = ${pageId}
    `;
    expect(rows[0]).toEqual({
      page_title: "아리엘라 EA 대사 작업",
      task_title: "아리엘라 EA 대사 작업",
      body_count: 1,
      reference_count: 1,
      daily_mount_count: 1,
      project_mount_count: 1,
      title_page_count: 1,
    });

    await expect(service.create({
      title: "아리엘라 EA 대사 작업",
      folderId,
      actor,
      idempotencyKey: "pr-ce:promote:new-browser-key",
    })).resolves.toMatchObject({ id: pageId, idempotent: true });
    await expect(identityCounts(pageId, projectPageId)).resolves.toEqual({
      page_count: 1,
      task_count: 1,
      project_mount_count: 1,
    });
  });

  it("converges concurrent same-title creates with different browser keys on one identity", async () => {
    const folderId = "folder-title-race";
    const projectPageId = "project-title-race";
    await createProject(folderId, projectPageId, "Title race project");
    const left = createService("00000000-0000-4000-8000-0000000000c1");
    const right = createService("00000000-0000-4000-8000-0000000000c2");

    const results = await Promise.all([
      left.create({ title: "동시 생성 업무", folderId, actor, idempotencyKey: "pr-ce:race:left" }),
      right.create({ title: "동시 생성 업무", folderId, actor, idempotencyKey: "pr-ce:race:right" }),
    ]);

    expect(results[0]?.id).toBe(results[1]?.id);
    await expect(identityCounts(results[0]!.id, projectPageId)).resolves.toEqual({
      page_count: 1,
      task_count: 1,
      project_mount_count: 1,
    });
  });

  it("converges concurrent promotions of the same standalone page", async () => {
    const folderId = "folder-title-promotion-race";
    const projectPageId = "project-title-promotion-race";
    const pageId = "page-title-promotion-race";
    await createProject(folderId, projectPageId, "Title promotion race project");
    await createPage(pageId, "동시 승격 업무", "승격 전 본문");

    const results = await Promise.all([
      createService("00000000-0000-4000-8000-0000000000d1").create({
        title: "동시 승격 업무",
        folderId,
        actor,
        idempotencyKey: "pr-ce:promotion-race:left",
      }),
      createService("00000000-0000-4000-8000-0000000000d2").create({
        title: "동시 승격 업무",
        folderId,
        actor,
        idempotencyKey: "pr-ce:promotion-race:right",
      }),
    ]);

    expect(results.map((result) => result.id)).toEqual([pageId, pageId]);
    await expect(identityCounts(pageId, projectPageId)).resolves.toEqual({
      page_count: 1,
      task_count: 1,
      project_mount_count: 1,
    });
  });

  it("rolls back the page promotion and project mount when a later task write fails", async () => {
    const folderId = "folder-title-promotion-rollback";
    const seedFolderId = "folder-title-promotion-rollback-seed";
    const projectPageId = "project-title-promotion-rollback";
    const pageId = "page-title-promotion-rollback";
    await createProject(folderId, projectPageId, "Title promotion rollback project");
    await harness.sql`
      INSERT INTO folders (id, name) VALUES (${seedFolderId}, 'Promotion rollback seed')
    `;
    const seedOperationIds = operationSequence([
      "promotion-rollback-collision",
      "promotion-rollback-seed-page",
    ]);
    const seed = await createService(
      "00000000-0000-4000-8000-0000000000d3",
      seedOperationIds,
    ).create({
      title: "승격 롤백 시드",
      folderId: seedFolderId,
      actor,
      idempotencyKey: "pr-ce:promotion-rollback:seed",
    });
    expect(seed.operation.id).toBe("promotion-rollback-collision");
    await createPage(pageId, "승격 롤백 대상", "보존할 본문");
    const promotionOperationIds = operationSequence([
      "promotion-rollback-project-mount",
      "promotion-rollback-collision",
      "promotion-rollback-page",
    ]);

    await expect(createService(
      "00000000-0000-4000-8000-0000000000d4",
      promotionOperationIds,
    ).create({
      title: "승격 롤백 대상",
      folderId,
      actor,
      idempotencyKey: "pr-ce:promotion-rollback:target",
    })).rejects.toThrow();

    const rows = await harness.sql<Array<{
      body_count: number;
      reference_count: number;
      task_count: number;
      board_item_count: number;
      project_mount_count: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM blocks
          WHERE page_id = ${pageId} AND text_plain = '보존할 본문') AS body_count,
        (SELECT COUNT(*)::int FROM blocks
          WHERE page_id = ${pageId} AND block_type = 'task_ref') AS reference_count,
        (SELECT COUNT(*)::int FROM tasks WHERE task_page_id = ${pageId}) AS task_count,
        (SELECT COUNT(*)::int FROM board_items WHERE item_id = ${pageId}) AS board_item_count,
        (SELECT COUNT(*)::int FROM block_links link
          JOIN blocks source ON source.id = link.source_block_id
          WHERE link.target_page_id = ${pageId} AND source.page_id = ${projectPageId}) AS project_mount_count
    `;
    expect(rows[0]).toEqual({
      body_count: 1,
      reference_count: 0,
      task_count: 0,
      board_item_count: 0,
      project_mount_count: 0,
    });
  });

  it("returns a user-facing 409 when the title already belongs to another project", async () => {
    const sourceFolderId = "folder-title-source";
    const targetFolderId = "folder-title-target";
    await harness.sql`
      INSERT INTO folders (id, name) VALUES
        (${sourceFolderId}, 'Title source'),
        (${targetFolderId}, 'Title target')
    `;
    await createService("00000000-0000-4000-8000-0000000000c3").create({
      title: "다른 프로젝트 업무",
      folderId: sourceFolderId,
      actor,
      idempotencyKey: "pr-ce:other-project:create",
    });
    const app = Fastify({ logger: false });
    try {
      registerTaskCreateRoute(app, {
        provider: {
          listFolders: () => [
            { id: sourceFolderId, name: "Title source" },
            { id: targetFolderId, name: "Title target" },
          ],
        },
        accessProvider: { resolveAccess: () => ({ restricted: false }) },
        httpClient: async () => ({ statusCode: 501 }),
        resolveDashboardUserId: () => actor.actorUserId,
        taskIdentityService: createService("00000000-0000-4000-8000-0000000000c4"),
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "다른 프로젝트 업무", folder_id: targetFolderId },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        detail: "같은 이름의 업무가 다른 프로젝트에 이미 있습니다. 기존 업무를 이동하거나 다른 이름을 사용해주세요.",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects archived, daily, project-root, and explicit-id collisions instead of repurposing them", async () => {
    const folderId = "folder-title-roles";
    const projectPageId = "project-title-roles";
    const standalonePageId = "page-title-explicit";
    const mountedPageId = "page-title-other-mount";
    const otherProjectPageId = "project-title-other-mount";
    await createProject(folderId, projectPageId, "프로젝트 루트 제목");
    await createProject(
      "folder-title-other-mount",
      otherProjectPageId,
      "외부 마운트 프로젝트",
    );
    await createPage(standalonePageId, "명시 ID 충돌", "본문");
    await createPage(mountedPageId, "외부 마운트 충돌", "본문");
    const otherProject = await pages.getBrowserPage(otherProjectPageId);
    await pages.mutatePage({
      pageId: otherProjectPageId,
      expectedVersion: otherProject.page.version,
      command: {
        type: "create_block",
        parentId: null,
        afterBlockId: null,
        blockType: "paragraph",
        text: "[[외부 마운트 충돌]]",
        properties: {},
      },
      actor,
      idempotencyKey: "pr-ce:test:mount-other-project",
    });
    await createPage("page-title-archived", "보관 제목 충돌", "본문");
    const archived = await pages.getBrowserPage("page-title-archived");
    await pages.mutatePage({
      pageId: "page-title-archived",
      expectedVersion: archived.page.version,
      command: { type: "archive_page" },
      actor,
      idempotencyKey: "pr-ce:test:archive-page",
    });
    await createPage("daily-title-role", "데일리 역할 제목", "메모", "2026-07-18");
    const service = createService("00000000-0000-4000-8000-0000000000c5");

    await expect(service.create({
      title: "보관 제목 충돌",
      folderId,
      actor,
      idempotencyKey: "pr-ce:archived-conflict",
    })).rejects.toThrow("같은 이름의 보관된 페이지가 이미 있습니다.");
    await expect(service.create({
      title: "데일리 역할 제목",
      folderId,
      actor,
      idempotencyKey: "pr-ce:daily-conflict",
    })).rejects.toThrow("같은 이름의 데일리 페이지가 이미 있습니다.");
    await expect(service.create({
      title: "프로젝트 루트 제목",
      folderId,
      actor,
      idempotencyKey: "pr-ce:project-root-conflict",
    })).rejects.toThrow("같은 이름의 프로젝트 페이지가 이미 있습니다.");
    await expect(service.create({
      title: "명시 ID 충돌",
      folderId,
      taskId: "00000000-0000-4000-8000-0000000000c6",
      actor,
      idempotencyKey: "pr-ce:explicit-id-conflict",
    })).rejects.toThrow("요청한 업무 ID와 같은 이름의 기존 페이지 ID가 다릅니다.");
    await expect(service.create({
      title: "외부 마운트 충돌",
      folderId,
      actor,
      idempotencyKey: "pr-ce:other-mount:conflict",
    })).rejects.toThrow("같은 이름의 페이지가 다른 프로젝트에 연결되어 있습니다.");

    const rows = await harness.sql<Array<{ task_count: number }>>`
      SELECT COUNT(*)::int AS task_count FROM tasks
      WHERE task_page_id IN (
        'page-title-archived', 'daily-title-role', ${projectPageId},
        ${standalonePageId}, ${mountedPageId}
      )
    `;
    expect(rows[0]?.task_count).toBe(0);
  });

  function createService(
    id: string,
    createOperationId: () => string = randomUUID,
  ): TaskIdentityService {
    return new TaskIdentityService({
      board: new TransactionBoardPort(),
      repository: new SqlTaskIdentityRepository(
        createLiveDbSqlResolver({ sql: harness.liveSql }),
      ),
      createId: () => id,
      createOperationId,
      hydratePage: async () => undefined,
    });
  }

  function operationSequence(ids: string[]): () => string {
    return () => ids.shift() ?? randomUUID();
  }

  async function createProject(folderId: string, pageId: string, title: string): Promise<void> {
    await createPage(pageId, title, "프로젝트 문서");
    await harness.sql`
      INSERT INTO folders (id, name, project_page_id) VALUES (${folderId}, ${title}, ${pageId})
    `;
  }

  async function createPage(
    pageId: string,
    title: string,
    text: string,
    dailyDate: string | null = null,
  ): Promise<void> {
    await pages.createPage({
      page: { id: pageId, title, dailyDate, metadata: {} },
      actor,
      idempotencyKey: `pr-ce:create-page:${pageId}`,
      initialCommand: {
        type: "batch_operations",
        operations: [{
          op: "create_block",
          tempId: `block-${pageId}`,
          parentId: null,
          afterBlockId: null,
          blockType: "paragraph",
          text,
          properties: {},
          collapsed: false,
        }],
      },
    });
  }

  async function identityCounts(taskId: string, projectPageId: string) {
    const rows = await harness.sql<Array<{
      page_count: number;
      task_count: number;
      project_mount_count: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM pages WHERE id = ${taskId}) AS page_count,
        (SELECT COUNT(*)::int FROM tasks WHERE task_page_id = ${taskId}) AS task_count,
        (SELECT COUNT(*)::int FROM block_links link
          JOIN blocks source ON source.id = link.source_block_id
          WHERE link.target_page_id = ${taskId} AND source.page_id = ${projectPageId}) AS project_mount_count
    `;
    return rows[0];
  }
});

class TransactionBoardPort implements TaskIdentityBoardPort {
  async withTaskBoardApplication<T>(
    input: Parameters<TaskIdentityBoardPort["withTaskBoardApplication"]>[0],
    persist: (application: TaskIdentityBoardApplication) => Promise<T>,
  ): Promise<T> {
    return await persist({
      documentName: `board-folder:${input.folderId}`,
      scope: {
        folderId: input.folderId,
        containerKind: "folder",
        containerId: input.folderId,
      },
      snapshot: new Uint8Array([1, 2, 3]),
      replica: {
        boardItems: [{
          id: input.boardItemId,
          folderId: input.folderId,
          containerKind: "folder",
          containerId: input.folderId,
          membershipKind: "primary",
          sourceTaskItemId: null,
          itemType: "task",
          itemId: input.taskId,
          x: input.x,
          y: input.y,
          metadata: { title: input.title, archived: input.archived },
        }],
        markdownDocuments: [],
      },
    });
  }

  async withTaskBoardMoveApplication(
    input: Parameters<TaskIdentityBoardPort["withTaskBoardMoveApplication"]>[0],
    persist: Parameters<TaskIdentityBoardPort["withTaskBoardMoveApplication"]>[1],
  ) {
    const moved = { ...input.boardItem, folderId: input.targetScope.folderId };
    await persist({ movedBoardItem: moved, boardApplications: [] });
    return moved;
  }
}
