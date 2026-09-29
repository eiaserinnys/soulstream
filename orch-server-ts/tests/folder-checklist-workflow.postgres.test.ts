import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { SqlFolderProjectIdentityRepository } from "../src/folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "../src/folders/folder_project_identity_service.js";
import { ChecklistControlPlaneService } from "../src/tasks/task_control_plane_service.js";
import { executeFolderOperation } from "../src/folders/folder_operations.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";
import { PageRepository } from "../src/page/page_repository.js";
import { PageYjsService } from "../src/page/page_service.js";

// Uses the same disposable PostgreSQL harness as folder-project-identity-postgres.
describe("unified folder and checklist workflow", () => {
  let h: PagePostgresHarness;
  beforeAll(async () => { h = await createPagePostgresHarness(); }, 60_000);
  afterAll(async () => { await h?.cleanup(); });

  it("retains checklist content, provenance and audit through off/on and completion", async () => {
    const resolver = createLiveDbSqlResolver({ sql: h.liveSql });
    const notifications: string[] = [];
    const handoff = vi.fn(async () => undefined);
    const checklist = new ChecklistControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), {
      appendEventTx: async () => { throw new Error("sessionless writes must not fabricate events"); },
    }, { emitFolderUpdated: async id => { notifications.push(id); }, notifyHumanHandoff: handoff });
    const identity = new FolderProjectIdentityService({
      repository: new SqlFolderProjectIdentityRepository(resolver),
      createId: () => "00000000-0000-4000-8000-0000000000c1", createOperationId: () => crypto.randomUUID(),
      withBoardApplication: async (_input, persist) => persist([]), hydratePage: async () => undefined,
    });
    const services = { identity, checklist };
    const actor = { actorKind: "user" as const, actorSessionId: null, actorUserId: "user@example.com" };
    const scope = { folderId: "00000000-0000-4000-8000-0000000000c1" };
    const call = (operation: Parameters<typeof executeFolderOperation>[1], body: unknown, extra = {}) =>
      executeFolderOperation(services, operation, body, { ...scope, ...extra }, actor);
    await call("create_folder", { name: "통일 폴더", idempotencyKey: "workflow:test:create" });
    const section = await call("create_checklist_section", { title: "저장된 섹션", idempotencyKey: "workflow:test:section" }) as any;
    const item = await call("create_checklist_item", { title: "저장된 항목", howTo: "유지해야 할 내용", idempotencyKey: "workflow:test:item" }, { sectionId: section.section.id }) as any;
    await call("set_checklist_item_status", { status: "completed", expectedVersion: 1, idempotencyKey: "workflow:test:done" }, { itemId: item.item.id });
    const enabled = { checklistEnabled: true, expectedVersion: 1, idempotencyKey: "workflow:test:on" };
    await call("set_folder_checklist_enabled", enabled);
    expect(await call("set_folder_checklist_enabled", enabled)).toMatchObject({ idempotent: true });
    await call("set_folder_checklist_enabled", { checklistEnabled: false, expectedVersion: 2, idempotencyKey: "workflow:test:off" });
    const off = await checklist.getFolder(scope.folderId);
    expect(off?.items).toEqual([expect.objectContaining({ title: "저장된 항목", how_to: "유지해야 할 내용", status: "completed", completed_kind: "user", completed_user_id: actor.actorUserId })]);
    await call("set_folder_status", { status: "completed", expectedVersion: 3, idempotencyKey: "workflow:test:complete" });
    expect((await checklist.getFolder(scope.folderId))?.folder).toMatchObject({ status: "completed", completed_kind: "user", completed_session_id: null });
    await call("set_folder_status", { status: "open", expectedVersion: 4, idempotencyKey: "workflow:test:reopen" });
    await call("set_folder_checklist_enabled", { checklistEnabled: true, expectedVersion: 5, idempotencyKey: "workflow:test:again" });
    expect((await checklist.getFolder(scope.folderId))?.items).toEqual(off?.items);
    const [{ count }] = await h.sql<[{ count: number }]>`SELECT count(*)::int AS count FROM folder_operations WHERE folder_id = ${scope.folderId}`;
    expect(count).toBe(9);
    expect(notifications).toHaveLength(8);
    expect(handoff).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ folderId: scope.folderId, itemId: item.item.id, status: "completed" }));
    await expect(call("set_folder_status", { status: "completed", expectedVersion: 1, idempotencyKey: "workflow:test:stale" })).rejects.toThrow(/version/i);
  });

  it("updates, moves, assigns and archives checklist rows through the shared HTTP/host operation boundary", async () => {
    await h.sql`INSERT INTO folders (id, name) VALUES ('checklist-crud', '체크리스트'), ('unrelated', '다른 폴더')`;
    const resolver = createLiveDbSqlResolver({ sql: h.liveSql });
    const checklist = new ChecklistControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), {
      appendEventTx: async () => { throw new Error("unexpected session event"); },
    });
    const identity = new FolderProjectIdentityService({
      repository: new SqlFolderProjectIdentityRepository(resolver),
      withBoardApplication: async (_input, persist) => persist([]), hydratePage: async () => undefined,
    });
    let sequence = 0;
    const call = async (operation: Parameters<typeof executeFolderOperation>[1], body: unknown, scope = {}) =>
      executeFolderOperation({ checklist, identity }, operation,
        { ...(body as object), idempotencyKey: `crud:test:${++sequence}` },
        { folderId: "checklist-crud", ...scope }, { actorKind: "user", actorSessionId: null, actorUserId: "user@example.com" }) as Promise<any>;
    const first = (await call("create_checklist_section", { title: "첫 섹션" })).section;
    let second = (await call("create_checklist_section", { title: "둘째 섹션" })).section;
    let item = (await call("create_checklist_item", { title: "항목", howTo: "작업 방법" }, { sectionId: first.id })).item;
    item = (await call("update_checklist_item", { title: "수정 항목", howTo: "수정 방법", expectedVersion: item.version }, { itemId: item.id })).item;
    item = (await call("set_checklist_item_assignee", { assigneeKind: "agent", assigneeAgentId: "roselin", expectedVersion: item.version }, { itemId: item.id })).item;
    item = (await call("move_checklist_item", { sectionId: second.id, expectedVersion: item.version }, { itemId: item.id })).item;
    expect(item).toMatchObject({ title: "수정 항목", howTo: "수정 방법", assigneeKind: "agent", assigneeAgentId: "roselin", sectionId: second.id, version: 4 });
    for (const operation of ["archive_checklist_item", "unarchive_checklist_item"] as const) {
      item = (await call(operation, { expectedVersion: item.version }, { itemId: item.id })).item;
    }
    item = (await call("set_checklist_item_status", { status: "review", expectedVersion: item.version }, { itemId: item.id })).item;
    expect(item).toMatchObject({ archived: false, status: "review", version: 7 });
    second = (await call("update_checklist_section", { title: "수정 섹션", expectedVersion: second.version }, { sectionId: second.id })).section;
    second = (await call("set_checklist_section_assignee", { assigneeKind: "human", assigneeUserId: "user@example.com", expectedVersion: second.version }, { sectionId: second.id })).section;
    second = (await call("move_checklist_section", { beforeSectionId: first.id, expectedVersion: second.version }, { sectionId: second.id })).section;
    for (const operation of ["archive_checklist_section", "unarchive_checklist_section"] as const) {
      second = (await call(operation, { expectedVersion: second.version }, { sectionId: second.id })).section;
    }
    expect(second).toMatchObject({ title: "수정 섹션", archived: false, assigneeKind: "human", version: 6 });
    expect(second.positionKey < first.positionKey).toBe(true);
    expect((await checklist.getFolder("checklist-crud"))?.items).toEqual([expect.objectContaining({ id: item.id, how_to: "수정 방법" })]);
    await expect(call("update_checklist_item", { title: "잘못된 수정", expectedVersion: item.version }, { folderId: "unrelated", itemId: item.id })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("reads ordinary and checklist folders through today, stars and bounded detail", async () => {
    const resolver = createLiveDbSqlResolver({ sql: h.liveSql });
    const pages = new PageYjsService({ repository: new PageRepository(resolver) });
    const actor = { actorKind: "user" as const, actorUserId: "user@example.com" };
    for (const id of ["ordinary", "checklist", "claude", "llm"]) {
      await pages.createPage({ page: { id, title: id, dailyDate: null, metadata: {} }, actor, idempotencyKey: `planner:page:${id}` });
      await h.sql`INSERT INTO folders (id, name, project_page_id, checklist_enabled) VALUES (${id}, ${id}, ${id}, ${id === "checklist"})`;
      await pages.mutatePage({ pageId: id, expectedVersion: 1, command: { type: "set_page_starred", starred: true }, actor, idempotencyKey: `planner:star:${id}` });
    }
    await pages.createPage({ page: { id: "day", title: "Today", dailyDate: "2026-09-30", metadata: {} }, actor, idempotencyKey: "planner:day:create",
      initialCommand: { type: "batch_operations", operations: ["ordinary", "checklist", "claude", "llm"].map((id) => ({ op: "create_block", tempId: id, parentId: null, afterBlockId: null,
        blockType: "paragraph", text: `[[${id}]]`, textDelta: [{ insert: `[[${id}]]`, attributes: { ref: { kind: "page", targetId: id } } }], properties: {} })) } });
    const planner = new PlannerRepository(resolver);
    expect((await planner.getToday("2026-09-30"))?.folders.map(row => row.folder.id).sort()).toEqual(["checklist", "ordinary"]);
    const first = await planner.getStarredFolders({ limit: 1 });
    const second = await planner.getStarredFolders({ limit: 1, cursor: first.nextCursor! });
    expect([...first.items, ...second.items].map(row => row.folder.id).sort()).toEqual(["checklist", "ordinary"]);
    expect(await planner.getFolder("ordinary", { limit: 10 })).toMatchObject({ folder: { id: "ordinary", checklistEnabled: false }, sections: [], items: [], subfolders: { items: [] }, documents: { items: [] }, sessions: { items: [] } });
    await pages.close();
  });
});
