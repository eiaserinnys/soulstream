import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PageRepository } from "../../src/page/page_repository.js";
import { PageYjsService } from "../../src/page/page_service.js";
import { readPageYDocReplica } from "../../src/page/page_yjs_model.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page_postgres_harness.js";

describe("PageYjsService PostgreSQL mutation integration", () => {
  let harness: PagePostgresHarness;
  let repository: PageRepository;
  let service: PageYjsService;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`INSERT INTO sessions (session_id) VALUES ('agent-session')`;
    repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    service = new PageYjsService({ repository });
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    await harness?.cleanup();
  });

  it("commits snapshot, replica, event, and operation before exposing the live update", async () => {
    const created = await service.createPage({
      page: { id: "page-1", title: "Page", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:create-1",
    });
    expect(created.page.version).toBe(1);
    expect(created.operation).toMatchObject({
      operation_type: "create_page",
      actor_kind: "agent",
      actor_session_id: "agent-session",
      expected_version: 0,
      result_version: 1,
    });

    const mutated = await service.mutatePage({
      pageId: "page-1",
      expectedVersion: 1,
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "batch_page_operations:agent-session:batch-1",
      command: {
        type: "batch_operations",
        operations: [
          {
            op: "create_block",
            tempId: "root",
            parentId: null,
            parentTempId: null,
            afterBlockId: null,
            afterTempId: null,
            blockType: "paragraph",
            text: "[[Page]]",
            properties: {},
          },
          {
            op: "create_block",
            tempId: "check",
            parentId: null,
            parentTempId: "root",
            afterBlockId: null,
            afterTempId: null,
            blockType: "checklist",
            text: "Check",
            properties: { checked: false },
          },
          { op: "set_check_state", blockId: "check", checked: true },
        ],
      },
    });
    expect(mutated.page.version).toBe(2);
    expect(mutated.blocks).toHaveLength(2);
    expect(mutated.temp_id_mapping).toMatchObject({ root: expect.any(String), check: expect.any(String) });

    const duplicate = await service.mutatePage({
      pageId: "page-1",
      expectedVersion: 1,
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "batch_page_operations:agent-session:batch-1",
      command: { type: "archive_page" },
    });
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.operation.id).toBe(mutated.operation.id);
    expect(duplicate.page.version).toBe(2);

    const [counts] = await harness.sql<[{
      operations: number;
      events: number;
      blocks: number;
      links: number;
    }]>`
      SELECT
        (SELECT COUNT(*)::int FROM block_operations) AS operations,
        (SELECT COUNT(*)::int FROM events WHERE event_type = 'block_operation') AS events,
        (SELECT COUNT(*)::int FROM blocks) AS blocks,
        (SELECT COUNT(*)::int FROM block_links) AS links
    `;
    expect(counts).toEqual({ operations: 2, events: 2, blocks: 2, links: 1 });
    const [link] = await harness.sql<[{
      link_kind: string;
      target_page_id: string | null;
      target_title: string;
    }]>`
      SELECT link_kind, target_page_id, target_title FROM block_links
    `;
    expect(link).toEqual({
      link_kind: "mount",
      target_page_id: "page-1",
      target_title: "Page",
    });
    const [page] = await harness.sql<[{ version: number; updated_session_id: string }]>`
      SELECT version, updated_session_id FROM pages WHERE id = 'page-1'
    `;
    expect(page).toEqual({ version: 2, updated_session_id: "agent-session" });
    const snapshot = await repository.getPageYjsSnapshot("page:page-1");
    expect(snapshot).not.toBeNull();
    expect(readPageYDocReplica("page-1", service.decodeSnapshot(snapshot!)).page.mutationVersion)
      .toBe(2);
  }, 30_000);

  it("does not change the live document when the database commit fails", async () => {
    const failing = new PageYjsService({
      repository: {
        getPageYjsSnapshot: repository.getPageYjsSnapshot.bind(repository),
        getPageMutationByIdempotencyKey: repository.getPageMutationByIdempotencyKey.bind(repository),
        hasPageOperation: repository.hasPageOperation.bind(repository),
        getPageTimestamps: repository.getPageTimestamps.bind(repository),
        commitPageMutation: async () => { throw new Error("commit failed"); },
        storePageYjsState: repository.storePageYjsState.bind(repository),
      },
    });
    try {
      const before = await failing.getPage("page-1");
      await expect(failing.mutatePage({
        pageId: "page-1",
        expectedVersion: 2,
        actor: { actorKind: "agent", actorSessionId: "agent-session" },
        idempotencyKey: "rename_page:agent-session:failure",
        command: { type: "rename_page", title: "Must not leak" },
      })).rejects.toThrow("commit failed");
      const after = await failing.getPage("page-1");
      expect(after).toEqual(before);
    } finally {
      await failing.close();
    }
  });
});
