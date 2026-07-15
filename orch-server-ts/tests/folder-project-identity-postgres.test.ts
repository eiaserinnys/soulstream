import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqlFolderProjectIdentityRepository } from "../src/folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "../src/folders/folder_project_identity_service.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

describe("Folder project identity PostgreSQL transaction", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("commits one UUID and synchronizes rename/archive from both surfaces", async () => {
    const id = "00000000-0000-4000-8000-0000000000af";
    const service = createService(id, ["folder-op-a", "page-op-a", "folder-op-b", "page-op-b"]);

    await expect(service.create({
      name: "원자 프로젝트",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "folder-project:create:success",
    })).resolves.toMatchObject({
      id,
      pageId: id,
      folder: { id, projectPageId: id },
    });
    await service.mutateFromFolder({
      folderId: id,
      update: { name: "폴더에서 바꾼 프로젝트" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "folder-project:rename:folder",
    });
    await service.mutateFromPage({
      pageId: id,
      expectedVersion: 2,
      command: { type: "rename_page", title: "페이지에서 바꾼 프로젝트" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "folder-project:rename:page",
    });
    await service.mutateFromFolder({
      folderId: id,
      archived: true,
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "folder-project:archive:folder",
    });
    await service.mutateFromPage({
      pageId: id,
      expectedVersion: 4,
      command: { type: "unarchive_page" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "folder-project:unarchive:page",
    });

    const rows = await harness.sql<Array<{
      folder_id: string;
      project_page_id: string;
      folder_name: string;
      page_title: string;
      folder_archived: boolean;
      page_archived: boolean;
    }>>`
      SELECT f.id AS folder_id, f.project_page_id,
             f.name AS folder_name, p.title AS page_title,
             f.archived AS folder_archived, p.archived AS page_archived
      FROM folders f JOIN pages p ON p.id = f.project_page_id
      WHERE f.id = ${id}
    `;
    expect(rows).toEqual([{
      folder_id: id,
      project_page_id: id,
      folder_name: "페이지에서 바꾼 프로젝트",
      page_title: "페이지에서 바꾼 프로젝트",
      folder_archived: false,
      page_archived: false,
    }]);
  });

  it("rolls back folder, page, Y.Doc, and operation when provenance insert fails", async () => {
    const id = "00000000-0000-4000-8000-0000000000b0";
    const service = createService(id, ["folder-op-rollback", "page-op-rollback"]);

    await expect(service.create({
      name: "롤백 프로젝트",
      actor: { actorKind: "agent", actorSessionId: "missing-session" },
      idempotencyKey: "folder-project:create:rollback",
    })).rejects.toThrow();

    const rows = await harness.sql<Array<{
      folders: number;
      pages: number;
      documents: number;
      operations: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM folders WHERE id = ${id}) AS folders,
        (SELECT COUNT(*)::int FROM pages WHERE id = ${id}) AS pages,
        (SELECT COUNT(*)::int FROM board_yjs_documents WHERE name = ${`page:${id}`}) AS documents,
        (SELECT COUNT(*)::int FROM folder_project_operations
          WHERE folder_id = ${id}) AS operations
    `;
    expect(rows[0]).toEqual({ folders: 0, pages: 0, documents: 0, operations: 0 });
  });

  function createService(id: string, operationIds: string[]) {
    return new FolderProjectIdentityService({
      repository: new SqlFolderProjectIdentityRepository(
        createLiveDbSqlResolver({ sql: harness.liveSql }),
      ),
      createId: () => id,
      createOperationId: () => operationIds.shift() ?? crypto.randomUUID(),
      hydratePage: async () => undefined,
    });
  }
});
