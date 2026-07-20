import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PageRepository } from "../src/page/page_repository.js";
import { PageYjsService } from "../src/page/page_service.js";
import type { PlannerTaskDto } from "../src/planner/planner_contract.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";
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

describe("Task identity PostgreSQL transaction", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`INSERT INTO folders (id, name) VALUES ('folder-a', 'Folder A')`;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("commits one UUID across page, task, board projection, and primary reference", async () => {
    const id = "00000000-0000-4000-8000-0000000000ae";
    const board = new TransactionBoardPort();
    const service = createService(board, id, ["task-op-a", "page-op-a"]);

    await expect(service.create({
      title: "원자 업무",
      description: "하나의 정체성",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:create:success",
    })).resolves.toMatchObject({ id, pageId: id, taskId: id });

    const rows = await harness.sql<Array<{
      task_id: string;
      task_page_id: string;
      board_item_id: string;
      page_id: string;
      reference_task_id: string;
    }>>`
      SELECT r.id AS task_id, r.task_page_id, r.board_item_id,
             p.id AS page_id, b.properties->>'taskId' AS reference_task_id
      FROM tasks r
      JOIN pages p ON p.id = r.task_page_id
      JOIN blocks b ON b.page_id = p.id
        AND b.block_type = 'task_ref'
        AND b.properties->>'primary' = 'true'
      WHERE r.id = ${id}
    `;
    expect(rows).toEqual([{
      task_id: id,
      task_page_id: id,
      board_item_id: `task:${id}`,
      page_id: id,
      reference_task_id: id,
    }]);
    expect(board.liveApplied).toBe(true);

    await service.mutateFromTask({
      taskId: id,
      expectedVersion: 1,
      title: "이름이 바뀐 업무",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:rename:task-surface",
    });
    await service.mutateFromPage({
      pageId: id,
      expectedVersion: 2,
      command: { type: "archive_page" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:archive:page-surface",
    });
    await expect(service.mutateFromPage({
      pageId: id,
      expectedVersion: 2,
      command: { type: "archive_page" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:archive:page-surface",
    })).resolves.toMatchObject({ idempotent: true });
    const synchronized = await harness.sql<Array<{
      task_title: string;
      page_title: string;
      task_archived: boolean;
      page_archived: boolean;
    }>>`
      SELECT r.title AS task_title, p.title AS page_title,
             r.archived AS task_archived, p.archived AS page_archived
      FROM tasks r JOIN pages p ON p.id = r.task_page_id
      WHERE r.id = ${id}
    `;
    expect(synchronized[0]).toEqual({
      task_title: "이름이 바뀐 업무",
      page_title: "이름이 바뀐 업무",
      task_archived: true,
      page_archived: true,
    });
  });

  it("mounts an HTTP-created identity into its project and resolves daily ownership immediately", async () => {
    const folderId = "folder-v1-projection";
    const projectPageId = "project-v1-projection";
    const taskId = "00000000-0000-4000-8000-0000000000c0";
    await harness.sql`INSERT INTO folders (id, name) VALUES (${folderId}, 'V1 projection')`;
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    const app = Fastify({ logger: false });
    try {
      await pages.createPage({
        page: {
          id: projectPageId,
          title: "V1 projection",
          dailyDate: null,
          metadata: { folderId },
        },
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:v1-projection:project",
      });
      await harness.sql`
        UPDATE folders SET project_page_id = ${projectPageId} WHERE id = ${folderId}
      `;
      const daily = await pages.getDailyPage({
        date: "2026-07-17",
        actor: { actorKind: "user", actorUserId: "user@example.com" },
      });
      const service = createService(
        new TransactionBoardPort(),
        taskId,
        [
          "task-op-v1-projection",
          "page-op-v1-projection",
          "project-page-op-v1-projection",
        ],
      );
      registerTaskCreateRoute(app, {
        provider: { listFolders: () => [{ id: folderId, name: "V1 projection" }] },
        accessProvider: { resolveAccess: () => ({ restricted: false }) },
        httpClient: async () => ({ statusCode: 501 }),
        resolveDashboardUserId: () => "user@example.com",
        taskIdentityService: service,
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: "v1에서 만든 업무",
          folder_id: folderId,
          idempotency_key: "task-identity:v1-projection:create",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ id: taskId, pageId: taskId, taskId: taskId });
      await expect(service.create({
        title: "v1에서 만든 업무",
        folderId,
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:v1-projection:create",
      })).resolves.toMatchObject({
        id: taskId,
        projectPageId,
        idempotent: true,
      });

      const project = await pages.getBrowserPage(projectPageId);
      expect(project.blocks.filter((block) => block.text === "[[v1에서 만든 업무]]"))
        .toHaveLength(1);
      await pages.mutatePage({
        pageId: daily.page.id,
        expectedVersion: daily.page.version,
        command: {
          type: "create_block",
          parentId: null,
          afterBlockId: null,
          blockType: "paragraph",
          text: "[[v1에서 만든 업무]]",
          properties: {},
        },
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:v1-projection:daily-mount",
      });
      const planner = new PlannerRepository(resolver);
      const projectPlanner = await planner.getProject(projectPageId, { limit: 20 });
      expect(projectPlanner?.tasks.items).toEqual([
        expect.objectContaining({
          page: expect.objectContaining({ id: taskId, title: "v1에서 만든 업무" }),
          task_id: taskId,
          project_page_id: projectPageId,
        }),
      ]);
      const todayPlanner = await planner.getToday("2026-07-17");
      expect(todayPlanner?.tasks).toEqual([
        expect.objectContaining({
          page: expect.objectContaining({ id: taskId }),
          project_page_id: projectPageId,
        }),
      ]);
    } finally {
      await app.close();
      await pages.close();
    }
  });

  it("keeps the v3 planner UX policy runbook_ref-only page visible across planner surfaces", async () => {
    const folderId = "folder-v3-planner-policy";
    const projectPageId = "page-v3-planner-policy-project";
    const taskPageId = "6d33e4dd-bda9-403d-bff7-e9d357e73fa3";
    const taskId = "rb-v3-context-menus-20260714";
    const taskTitle = "v3 플래너 UX 폴리시";
    const sessionId = "session-v3-planner-policy";
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    try {
      await harness.sql`
        INSERT INTO folders (id, name) VALUES (${folderId}, 'v3 planner policy project')
      `;
      await pages.createPage({
        page: {
          id: taskPageId,
          title: taskTitle,
          dailyDate: null,
          metadata: { starred: true },
        },
        initialCommand: {
          type: "batch_operations",
          operations: [{
            op: "create_block",
            tempId: "legacy-runbook-ref",
            parentId: null,
            afterBlockId: null,
            blockType: "runbook_ref",
            text: "",
            properties: { primary: true, runbookId: taskId },
            collapsed: false,
          }],
        },
        actor: { actorKind: "system" },
        idempotencyKey: "task-identity:v3-planner-policy:task-page",
      });
      const project = await pages.createPage({
        page: {
          id: projectPageId,
          title: "v3 planner policy project",
          dailyDate: null,
          metadata: { folderId },
        },
        initialCommand: {
          type: "batch_operations",
          operations: [{
            op: "create_block",
            tempId: "legacy-project-mount",
            parentId: null,
            afterBlockId: null,
            blockType: "paragraph",
            text: `[[${taskTitle}]]`,
            properties: {},
            collapsed: false,
          }],
        },
        actor: { actorKind: "system" },
        idempotencyKey: "task-identity:v3-planner-policy:project-page",
      });
      await harness.sql`
        UPDATE folders SET project_page_id = ${projectPageId} WHERE id = ${folderId}
      `;
      await harness.sql`
        INSERT INTO board_items (
          id, folder_id, container_kind, container_id, membership_kind,
          item_type, item_id, metadata
        ) VALUES (
          ${`task:${taskId}`}, ${folderId}, 'folder', ${folderId}, 'primary',
          'task', ${taskId}, ${harness.sql.json({ title: taskTitle })}::jsonb
        )
      `;
      await harness.sql`
        INSERT INTO tasks (id, board_item_id, task_page_id, title)
        VALUES (${taskId}, ${`task:${taskId}`}, NULL, ${taskTitle})
      `;
      await harness.sql`
        INSERT INTO sessions (session_id, status) VALUES (${sessionId}, 'completed')
      `;
      await harness.sql`
        INSERT INTO board_items (
          id, folder_id, container_kind, container_id, membership_kind,
          item_type, item_id
        ) VALUES (
          ${`session:${sessionId}`}, ${folderId}, 'task', ${taskId}, 'primary',
          'session', ${sessionId}
        )
      `;
      const daily = await pages.getDailyPage({
        date: "2026-07-18",
        actor: { actorKind: "system" },
      });
      await pages.mutatePage({
        pageId: daily.page.id,
        expectedVersion: daily.page.version,
        command: {
          type: "create_block",
          parentId: null,
          afterBlockId: null,
          blockType: "paragraph",
          text: `[[${taskTitle}]]`,
          properties: {},
        },
        actor: { actorKind: "system" },
        idempotencyKey: "task-identity:v3-planner-policy:daily-mount",
      });

      const planner = new PlannerRepository(resolver);
      const projectPlanner = await planner.getProject(project.page.id, { limit: 20 });
      expect(projectPlanner?.tasks.items).toEqual([
        expect.objectContaining({
          page: expect.objectContaining({ id: taskPageId }),
          task_id: taskId,
          project_page_id: projectPageId,
        }),
      ]);
      expect(projectPlanner?.documents.items).toEqual([]);
      expect((await planner.getToday("2026-07-18"))?.tasks).toEqual([
        expect.objectContaining({ task_id: taskId }),
      ]);
      expect((await planner.getStarredTasks({ limit: 50 })).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: taskPageId })]),
      );
      await expect(planner.getTaskRuns(taskPageId, { limit: 20 })).resolves.toMatchObject({
        items: [{ agent_session_id: sessionId }],
        total: 1,
      });
    } finally {
      await pages.close();
    }
  });

  it("executes the full starred task query in PostgreSQL with both identities and a two-page cursor", async () => {
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    const fixtures = [
      {
        pageId: "starred-full-page-task-ref-a",
        taskId: "starred-full-task-ref-a",
        title: "별표 전체 업무 A",
        blockType: "task_ref",
        referenceKey: "taskId",
        updatedAt: "2030-01-03T00:00:00.000000Z",
      },
      {
        pageId: "starred-full-page-runbook-ref-b",
        taskId: "starred-full-runbook-ref-b",
        title: "별표 전체 업무 B",
        blockType: "runbook_ref",
        referenceKey: "runbookId",
        updatedAt: "2030-01-02T00:00:00.000000Z",
      },
      {
        pageId: "starred-full-page-task-ref-c",
        taskId: "starred-full-task-ref-c",
        title: "별표 전체 업무 C",
        blockType: "task_ref",
        referenceKey: "taskId",
        updatedAt: "2030-01-01T00:00:00.000000Z",
      },
    ] as const;
    try {
      for (const fixture of fixtures) {
        await pages.createPage({
          page: {
            id: fixture.pageId,
            title: fixture.title,
            dailyDate: null,
            metadata: { starred: true },
          },
          initialCommand: {
            type: "batch_operations",
            operations: [{
              op: "create_block",
              tempId: `${fixture.pageId}-identity`,
              parentId: null,
              afterBlockId: null,
              blockType: fixture.blockType,
              text: "",
              properties: { primary: true, [fixture.referenceKey]: fixture.taskId },
              collapsed: false,
            }],
          },
          actor: { actorKind: "system" },
          idempotencyKey: `task-identity:starred-full:${fixture.pageId}`,
        });
        await harness.sql`
          INSERT INTO board_items (
            id, folder_id, container_kind, container_id, membership_kind,
            item_type, item_id, metadata
          ) VALUES (
            ${`task:${fixture.taskId}`}, 'folder-a', 'folder', 'folder-a', 'primary',
            'task', ${fixture.taskId}, ${harness.sql.json({ title: fixture.title })}::jsonb
          )
        `;
        await harness.sql`
          INSERT INTO tasks (id, board_item_id, task_page_id, title)
          VALUES (
            ${fixture.taskId},
            ${`task:${fixture.taskId}`},
            ${fixture.blockType === "task_ref" ? fixture.pageId : null},
            ${fixture.title}
          )
        `;
        await harness.sql`
          UPDATE pages SET updated_at = ${fixture.updatedAt}::timestamptz
          WHERE id = ${fixture.pageId}
        `;
      }
      await harness.sql`
        INSERT INTO task_sections (
          id, task_id, position_key, assignee_agent_id
        ) VALUES (
          'starred-full-section-a', ${fixtures[0].taskId}, 'a', 'roselin_codex'
        )
      `;
      await harness.sql`
        INSERT INTO task_items (id, section_id, position_key, status)
        VALUES ('starred-full-item-a', 'starred-full-section-a', 'a', 'review')
      `;

      const planner = new PlannerRepository(resolver);
      const first = await planner.getStarredTasks({ detail: "full", limit: 2 });
      const firstItems = first.items as PlannerTaskDto[];
      expect(firstItems.map((item) => item.page.id)).toEqual([
        fixtures[0].pageId,
        fixtures[1].pageId,
      ]);
      expect(first.next_cursor).toEqual(expect.any(String));
      expect(firstItems).toEqual([
        expect.objectContaining({
          page: expect.objectContaining({ id: fixtures[0].pageId, title: fixtures[0].title }),
          task_id: fixtures[0].taskId,
          task: expect.objectContaining({
            id: fixtures[0].taskId,
            item_counts: { review: 1 },
            item_total: 1,
            assignee: "roselin_codex",
          }),
          blocks: expect.arrayContaining([
            expect.objectContaining({
              block_type: "task_ref",
              properties: expect.objectContaining({ taskId: fixtures[0].taskId }),
            }),
          ]),
        }),
        expect.objectContaining({
          page: expect.objectContaining({ id: fixtures[1].pageId, title: fixtures[1].title }),
          task_id: fixtures[1].taskId,
          task: expect.objectContaining({ id: fixtures[1].taskId }),
          blocks: expect.arrayContaining([
            expect.objectContaining({
              block_type: "runbook_ref",
              properties: expect.objectContaining({ runbookId: fixtures[1].taskId }),
            }),
          ]),
        }),
      ]);

      const second = await planner.getStarredTasks({
        detail: "full",
        cursor: first.next_cursor!,
        limit: 2,
      });
      const secondItems = second.items as PlannerTaskDto[];
      expect(secondItems[0]).toEqual(expect.objectContaining({
        page: expect.objectContaining({ id: fixtures[2].pageId }),
        task_id: fixtures[2].taskId,
      }));
      expect(secondItems.map((item) => item.page.id)).not.toContain(fixtures[1].pageId);
    } finally {
      await pages.close();
    }
  }, 60_000);

  it("moves the project mount atomically, preserves daily ownership, then removes every mount on archive", async () => {
    const sourceFolderId = "folder-lifecycle-source";
    const targetFolderId = "folder-lifecycle-target";
    const sourceProjectPageId = "project-lifecycle-source";
    const targetProjectPageId = "project-lifecycle-target";
    const taskId = "00000000-0000-4000-8000-0000000000c1";
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    const board = new TransactionBoardPort();
    try {
      for (const project of [
        { folderId: sourceFolderId, pageId: sourceProjectPageId, title: "Source project" },
        { folderId: targetFolderId, pageId: targetProjectPageId, title: "Target project" },
      ]) {
        await pages.createPage({
          page: {
            id: project.pageId,
            title: project.title,
            dailyDate: null,
            metadata: { folderId: project.folderId },
          },
          actor: { actorKind: "user", actorUserId: "user@example.com" },
          idempotencyKey: `task-identity:lifecycle:${project.folderId}`,
        });
        await harness.sql`
          INSERT INTO folders (id, name, project_page_id)
          VALUES (${project.folderId}, ${project.title}, ${project.pageId})
        `;
      }
      const daily = await pages.getDailyPage({
        date: "2026-07-18",
        actor: { actorKind: "user", actorUserId: "user@example.com" },
      });
      const service = createService(board, taskId, [
        "lifecycle-create-task",
        "lifecycle-create-page",
        "lifecycle-create-project-mount",
      ]);
      await service.create({
        title: "이동 후 아카이브 업무",
        folderId: sourceFolderId,
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:lifecycle:create",
      });
      await pages.mutatePage({
        pageId: daily.page.id,
        expectedVersion: daily.page.version,
        command: {
          type: "create_block",
          parentId: null,
          afterBlockId: null,
          blockType: "paragraph",
          text: "[[이동 후 아카이브 업무]]",
          properties: {},
        },
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:lifecycle:daily-mount",
      });

      await service.moveBoardItemToContainer({
        boardItem: taskBoardItem(taskId, sourceFolderId),
        targetScope: {
          folderId: targetFolderId,
          containerKind: "folder",
          containerId: targetFolderId,
        },
        idempotencyKey: "task-identity:lifecycle:move",
      });

      const moved = await lifecycleSnapshot(taskId);
      expect(moved).toEqual({
        folder_id: targetFolderId,
        task_version: 2,
        task_archived: false,
        project_mount_pages: [targetProjectPageId],
        daily_mount_pages: [daily.page.id],
      });

      await service.mutateFromTask({
        taskId: taskId,
        expectedVersion: 2,
        archived: true,
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:lifecycle:archive",
      });

      const archived = await lifecycleSnapshot(taskId);
      expect(archived).toEqual({
        folder_id: targetFolderId,
        task_version: 3,
        task_archived: true,
        project_mount_pages: [],
        daily_mount_pages: [],
      });
    } finally {
      await pages.close();
    }
  });

  it("rolls board and both project pages back when the final move operation write fails", async () => {
    const sourceFolderId = "folder-move-rollback-source";
    const targetFolderId = "folder-move-rollback-target";
    const sourceProjectPageId = "project-move-rollback-source";
    const targetProjectPageId = "project-move-rollback-target";
    const taskId = "00000000-0000-4000-8000-0000000000c2";
    const collisionOperationId = "move-rollback-collision";
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    const board = new TransactionBoardPort();
    try {
      for (const project of [
        { folderId: sourceFolderId, pageId: sourceProjectPageId },
        { folderId: targetFolderId, pageId: targetProjectPageId },
      ]) {
        await pages.createPage({
          page: {
            id: project.pageId,
            title: project.folderId,
            dailyDate: null,
            metadata: { folderId: project.folderId },
          },
          actor: { actorKind: "user", actorUserId: "user@example.com" },
          idempotencyKey: `task-identity:move-rollback:${project.folderId}`,
        });
        await harness.sql`
          INSERT INTO folders (id, name, project_page_id)
          VALUES (${project.folderId}, ${project.folderId}, ${project.pageId})
        `;
      }
      const service = createService(board, taskId, [
        "move-rollback-create-task",
        "move-rollback-create-page",
        "move-rollback-create-project-mount",
        "move-rollback-source-mount",
        "move-rollback-target-mount",
        collisionOperationId,
      ]);
      await service.create({
        title: "이동 롤백 업무",
        folderId: sourceFolderId,
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:move-rollback:create",
      });
      await harness.sql`
        INSERT INTO task_operations (
          id, task_id, target_kind, target_id, operation_type,
          actor_kind, idempotency_key, payload_json, reason
        ) VALUES (
          ${collisionOperationId}, ${taskId}, 'task', ${taskId}, 'update_task',
          'system', 'task-identity:move-rollback:collision', '{}'::jsonb, 'collision seed'
        )
      `;
      board.liveApplied = false;

      await expect(service.moveBoardItemToContainer({
        boardItem: taskBoardItem(taskId, sourceFolderId),
        targetScope: {
          folderId: targetFolderId,
          containerKind: "folder",
          containerId: targetFolderId,
        },
        idempotencyKey: "task-identity:move-rollback:move",
      })).rejects.toThrow();

      await expect(lifecycleSnapshot(taskId)).resolves.toEqual({
        folder_id: sourceFolderId,
        task_version: 1,
        task_archived: false,
        project_mount_pages: [sourceProjectPageId],
        daily_mount_pages: [],
      });
      expect(board.liveApplied).toBe(false);
    } finally {
      await pages.close();
    }
  });

  it("rolls back the project mount with board, page, and task records when a later write fails", async () => {
    const id = "00000000-0000-4000-8000-0000000000af";
    const seedId = "00000000-0000-4000-8000-0000000000ad";
    const folderId = "folder-project-rollback";
    const projectPageId = "project-page-rollback";
    const board = new TransactionBoardPort();
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    try {
      await pages.createPage({
        page: {
          id: projectPageId,
          title: "Rollback project",
          dailyDate: null,
          metadata: { folderId },
        },
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:rollback:project",
      });
      await harness.sql`
        INSERT INTO folders (id, name, project_page_id)
        VALUES (${folderId}, 'Rollback project', ${projectPageId})
      `;
      await createService(
        new TransactionBoardPort(),
        seedId,
        ["task-op-b", "seed-page-op-b"],
      ).create({
        title: "operation collision seed",
        folderId: "folder-a",
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:create:rollback-seed",
      });
      const service = createService(
        board,
        id,
        ["task-op-b", "page-op-b", "project-page-op-b"],
      );

      await expect(service.create({
        title: "롤백 업무",
        folderId,
        actor: { actorKind: "user", actorUserId: "user@example.com" },
        idempotencyKey: "task-identity:create:rollback",
      })).rejects.toThrow();

      const rows = await harness.sql<Array<{
        pages: number;
        tasks: number;
        board_items: number;
        project_mount_blocks: number;
      }>>`
        SELECT
          (SELECT COUNT(*)::int FROM pages WHERE id = ${id}) AS pages,
          (SELECT COUNT(*)::int FROM tasks WHERE id = ${id}) AS tasks,
          (SELECT COUNT(*)::int FROM board_items WHERE id = ${`task:${id}`}) AS board_items,
          (SELECT COUNT(*)::int FROM blocks
            WHERE page_id = ${projectPageId}
              AND text_plain = '[[롤백 업무]]') AS project_mount_blocks
      `;
      expect(rows[0]).toEqual({
        pages: 0,
        tasks: 0,
        board_items: 0,
        project_mount_blocks: 0,
      });
      expect(board.liveApplied).toBe(false);
    } finally {
      await pages.close();
    }
  });

  it("recovers the original UUID when a create response is lost and retried", async () => {
    const committedId = "00000000-0000-4000-8000-0000000000b0";
    const discardedRetryId = "00000000-0000-4000-8000-0000000000b1";
    const idempotencyKey = "task-identity:create:response-loss";
    const firstBoard = new TransactionBoardPort();
    const firstService = createService(firstBoard, committedId, ["task-op-c", "page-op-c"]);

    await firstService.create({
      title: "응답 유실 업무",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey,
    });

    const retryBoard = new TransactionBoardPort();
    const retryService = createService(
      retryBoard,
      discardedRetryId,
      ["task-op-d", "page-op-d"],
    );
    await expect(retryService.create({
      title: "응답 유실 업무",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey,
    })).resolves.toMatchObject({
      id: committedId,
      pageId: committedId,
      taskId: committedId,
      idempotent: true,
    });

    const counts = await harness.sql<Array<{ tasks: number; pages: number }>>`
      SELECT
        (SELECT COUNT(*)::int FROM tasks
          WHERE id IN (${committedId}, ${discardedRetryId})) AS tasks,
        (SELECT COUNT(*)::int FROM pages
          WHERE id IN (${committedId}, ${discardedRetryId})) AS pages
    `;
    expect(counts[0]).toEqual({ tasks: 1, pages: 1 });
    expect(retryBoard.liveApplied).toBe(false);
  });

  it("keeps a legacy task bound to the first backfill page across retries", async () => {
    const taskId = "legacy-task-ae";
    const firstPageId = "00000000-0000-4000-8000-0000000000b2";
    const discardedRetryPageId = "00000000-0000-4000-8000-0000000000b3";
    const boardItemId = `task:${taskId}`;
    await harness.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        item_type, item_id, metadata
      ) VALUES (
        ${boardItemId}, 'folder-a', 'folder', 'folder-a', 'primary',
        'task', ${taskId}, ${harness.sql.json({ title: "기존 업무" })}::jsonb
      )
    `;
    await harness.sql`
      INSERT INTO tasks (id, board_item_id, title)
      VALUES (${taskId}, ${boardItemId}, '기존 업무')
    `;
    const idempotencyKey = "task-identity:backfill:response-loss";
    const firstService = createService(
      new TransactionBoardPort(),
      firstPageId,
      ["task-op-e", "page-op-e"],
    );
    await expect(firstService.backfillLegacyTask({
      taskId,
      actor: { actorKind: "system" },
      idempotencyKey,
    })).resolves.toMatchObject({ taskId, pageId: firstPageId, createdPage: true });

    const retryService = createService(
      new TransactionBoardPort(),
      discardedRetryPageId,
      ["task-op-f", "page-op-f"],
    );
    await expect(retryService.backfillLegacyTask({
      taskId,
      actor: { actorKind: "system" },
      idempotencyKey,
    })).resolves.toMatchObject({
      taskId,
      pageId: firstPageId,
      createdPage: true,
      idempotent: true,
    });

    const bindings = await harness.sql<Array<{
      task_page_id: string;
      created_pages: number;
      reference_task_id: string;
    }>>`
      SELECT r.task_page_id,
             (SELECT COUNT(*)::int FROM pages
               WHERE id IN (${firstPageId}, ${discardedRetryPageId})) AS created_pages,
             b.properties->>'taskId' AS reference_task_id
      FROM tasks r
      JOIN blocks b ON b.page_id = r.task_page_id
        AND b.block_type = 'task_ref'
        AND b.properties->>'primary' = 'true'
      WHERE r.id = ${taskId}
    `;
    expect(bindings).toEqual([{
      task_page_id: firstPageId,
      created_pages: 1,
      reference_task_id: taskId,
    }]);
  });

  function createService(
    board: TransactionBoardPort,
    id: string,
    operationIds: string[],
  ): TaskIdentityService {
    return new TaskIdentityService({
      board,
      repository: new SqlTaskIdentityRepository(
        createLiveDbSqlResolver({ sql: harness.liveSql }),
      ),
      createId: () => id,
      createOperationId: () => operationIds.shift() ?? randomUUID(),
      hydratePage: async () => undefined,
    });
  }

  async function lifecycleSnapshot(taskId: string) {
    const rows = await harness.sql<Array<{
      folder_id: string;
      task_version: number;
      task_archived: boolean;
      project_mount_pages: string[];
      daily_mount_pages: string[];
    }>>`
      SELECT
        board_item.folder_id,
        task.version::int AS task_version,
        task.archived AS task_archived,
        COALESCE(array_agg(DISTINCT source.page_id ORDER BY source.page_id)
          FILTER (WHERE project_folder.id IS NOT NULL), '{}') AS project_mount_pages,
        COALESCE(array_agg(DISTINCT source.page_id ORDER BY source.page_id)
          FILTER (WHERE source_page.daily_date IS NOT NULL), '{}') AS daily_mount_pages
      FROM tasks task
      JOIN board_items board_item ON board_item.id = task.board_item_id
      LEFT JOIN block_links link
        ON link.target_page_id = task.task_page_id
       AND link.link_kind = 'mount'
      LEFT JOIN blocks source ON source.id = link.source_block_id
      LEFT JOIN pages source_page ON source_page.id = source.page_id
      LEFT JOIN folders project_folder ON project_folder.project_page_id = source.page_id
      WHERE task.id = ${taskId}
      GROUP BY board_item.folder_id, task.version, task.archived
    `;
    if (!rows[0]) throw new Error(`lifecycle snapshot missing: ${taskId}`);
    return rows[0];
  }
});

class TransactionBoardPort implements TaskIdentityBoardPort {
  liveApplied = false;

  async withTaskBoardApplication<T>(
    input: Parameters<TaskIdentityBoardPort["withTaskBoardApplication"]>[0],
    persist: (application: TaskIdentityBoardApplication) => Promise<T>,
  ): Promise<T> {
    const result = await persist({
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
    this.liveApplied = true;
    return result;
  }

  async withTaskBoardMoveApplication(
    input: Parameters<TaskIdentityBoardPort["withTaskBoardMoveApplication"]>[0],
    persist: Parameters<TaskIdentityBoardPort["withTaskBoardMoveApplication"]>[1],
  ) {
    const moved = {
      ...input.boardItem,
      folderId: input.targetScope.folderId,
      containerKind: input.targetScope.containerKind,
      containerId: input.targetScope.containerId,
      x: input.position?.x ?? input.boardItem.x,
      y: input.position?.y ?? input.boardItem.y,
    };
    await persist({
      movedBoardItem: moved,
      boardApplications: [
        {
          documentName: `board-folder:${input.boardItem.folderId}`,
          scope: {
            folderId: input.boardItem.folderId,
            containerKind: "folder",
            containerId: input.boardItem.folderId,
          },
          snapshot: new Uint8Array([4, 5, 6]),
          replica: { boardItems: [], markdownDocuments: [] },
        },
        {
          documentName: `board-folder:${input.targetScope.folderId}`,
          scope: input.targetScope,
          snapshot: new Uint8Array([7, 8, 9]),
          replica: { boardItems: [moved], markdownDocuments: [] },
        },
      ],
    });
    this.liveApplied = true;
    return moved;
  }
}

function taskBoardItem(taskId: string, folderId: string) {
  return {
    id: `task:${taskId}`,
    folderId,
    containerKind: "folder" as const,
    containerId: folderId,
    membershipKind: "primary" as const,
    sourceTaskItemId: null,
    itemType: "task" as const,
    itemId: taskId,
    x: 0,
    y: 0,
    metadata: {},
  };
}
