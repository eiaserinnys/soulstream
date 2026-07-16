import Fastify from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { PageRepository } from "../../src/page/page_repository.js";
import {
  PageMutationIdempotencyConflictError,
  PageMutationStateVectorConflictError,
  PageMutationVersionConflictError,
} from "../../src/page/page_mutation_helpers.js";
import { PageYjsService } from "../../src/page/page_service.js";
import { readPageYDocReplica } from "../../src/page/page_yjs_model.js";
import { registerPageYjsRoutes } from "../../src/page/page_yjs_route.js";
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
    service = new PageYjsService({
      repository,
      now: () => new Date("2026-07-11T15:30:00.000Z"),
      createPageId: () => "daily-page-1",
    });
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
      yjs_updates: number;
    }]>`
      SELECT
        (SELECT COUNT(*)::int FROM block_operations) AS operations,
        (SELECT COUNT(*)::int FROM events WHERE event_type = 'block_operation') AS events,
        (SELECT COUNT(*)::int FROM blocks) AS blocks,
        (SELECT COUNT(*)::int FROM block_links) AS links,
        (SELECT COUNT(*)::int FROM board_yjs_updates) AS yjs_updates
    `;
    expect(counts).toEqual({
      operations: 2,
      events: 2,
      blocks: 2,
      links: 1,
      yjs_updates: 0,
    });
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
    const checklistBlockId = mutated.temp_id_mapping.check!;
    const projectionRows = await harness.sql<Array<{
      actor_kind: string;
      actor_session_id: string | null;
      actor_user_id: string | null;
      routing_session_id: string | null;
      processed_hash: string | null;
    }>>`
      SELECT actor_kind, actor_session_id, actor_user_id, routing_session_id, processed_hash
      FROM checklist_runbook_projection_outbox
      WHERE block_id = ${checklistBlockId}
    `;
    const projection = projectionRows[0];
    expect(projection).toEqual({
      actor_kind: "agent",
      actor_session_id: "agent-session",
      actor_user_id: null,
      routing_session_id: "agent-session",
      processed_hash: null,
    });
    const snapshot = await repository.getPageYjsSnapshot("page:page-1");
    expect(snapshot).not.toBeNull();
    expect(readPageYDocReplica("page-1", service.decodeSnapshot(snapshot!)).page.mutationVersion)
      .toBe(2);
  }, 30_000);

  it("moves a mixed block forest and its primary session binding in one transaction", async () => {
    await harness.sql`INSERT INTO sessions (session_id) VALUES ('moved-session')`;
    await harness.sql`
      INSERT INTO session_page_bindings (
        session_id, node_id, daily_date, session_type, page_state, legacy_state
      ) VALUES (
        'moved-session', 'test-node', '2026-07-13', 'agent', 'pending', 'completed'
      )
    `;
    await service.createPage({
      page: { id: "transfer-source", title: "Transfer source", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:transfer-source",
      initialCommand: {
        type: "batch_operations",
        operations: [
          createBlock("before", null, null, "paragraph", "Before"),
          createBlock("text-root", null, "before", "paragraph", "Move me"),
          createBlock("check-child", "text-root", null, "checklist", "Child", { checked: true }, true),
          createBlock(
            "session-ref",
            null,
            "text-root",
            "session_ref",
            "",
            { sessionId: "moved-session", primary: true },
          ),
          createBlock("after", null, "session-ref", "paragraph", "After"),
        ],
      },
    });
    await harness.sql`
      UPDATE session_page_bindings
      SET target_page_id = 'transfer-source', target_block_id = 'session-ref',
          target_expected_version = 1, page_state = 'bound'
      WHERE session_id = 'moved-session'
    `;
    await service.createPage({
      page: { id: "transfer-target", title: "Transfer target", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:transfer-target",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("target-root", null, null, "paragraph", "Target")],
      },
    });
    const sourceBefore = await service.getBrowserPage("transfer-source");
    const targetBefore = await service.getBrowserPage("transfer-target");
    const input = {
      source: {
        pageId: "transfer-source",
        expectedVersion: sourceBefore.page.version,
        expectedStateVector: decodeStateVector(sourceBefore.state_vector),
        blockIds: ["text-root", "session-ref"],
      },
      target: {
        kind: "existing" as const,
        pageId: "transfer-target",
        expectedVersion: targetBefore.page.version,
        expectedStateVector: decodeStateVector(targetBefore.state_vector),
        parentId: null,
        afterBlockId: "target-root",
      },
      actor: { actorKind: "agent" as const, actorSessionId: "agent-session" },
      idempotencyKey: "page-transfer:agent-session:mixed",
    };

    const concurrentResults = await Promise.all([
      service.transferBlocks(input),
      service.transferBlocks(input),
    ]);
    const moved = concurrentResults[0]!;

    expect(moved.source.blocks.map((block) => block.id)).toEqual(["before", "after"]);
    expect(moved.target.blocks.map((block) => block.id)).toEqual([
      "target-root", "text-root", "check-child", "session-ref",
    ]);
    expect(moved.target.blocks.find((block) => block.id === "check-child")).toMatchObject({
      parent_id: "text-root",
      block_type: "checklist",
      properties: { checked: true },
      collapsed: true,
    });
    expect(concurrentResults.some((result) => (
      result.source.idempotent === true && result.target.idempotent === true
    ))).toBe(true);
    expect(moved.target.blocks.find((block) => block.id === "session-ref")).toMatchObject({
      block_type: "session_ref",
      properties: { sessionId: "moved-session", primary: true },
    });
    const [binding] = await harness.sql<[{
      target_page_id: string;
      target_block_id: string;
      target_expected_version: number;
      page_state: string;
    }]>`
      SELECT target_page_id, target_block_id, target_expected_version, page_state
      FROM session_page_bindings WHERE session_id = 'moved-session'
    `;
    expect(binding).toEqual({
      target_page_id: "transfer-target",
      target_block_id: "session-ref",
      target_expected_version: 2,
      page_state: "bound",
    });

    const duplicate = await service.transferBlocks(input);
    expect(duplicate.source.idempotent).toBe(true);
    expect(duplicate.target.idempotent).toBe(true);
    expect(duplicate.target.blocks.map((block) => block.id)).toEqual(moved.target.blocks.map((block) => block.id));
    await expect(service.transferBlocks({
      ...input,
      target: { ...input.target, afterBlockId: null },
    })).rejects.toBeInstanceOf(PageMutationIdempotencyConflictError);
    await expect(service.transferBlocks({
      ...input,
      target: { kind: "new", pageId: "mode-change-target", title: "Mode change" },
    })).rejects.toBeInstanceOf(PageMutationIdempotencyConflictError);

    const targetCurrent = await service.getBrowserPage("transfer-target");
    const samePageInput = {
      source: {
        pageId: "transfer-target",
        expectedVersion: targetCurrent.page.version,
        expectedStateVector: decodeStateVector(targetCurrent.state_vector),
        blockIds: ["session-ref"],
      },
      target: {
        kind: "existing",
        pageId: "transfer-target",
        expectedVersion: targetCurrent.page.version,
        expectedStateVector: decodeStateVector(targetCurrent.state_vector),
        parentId: "text-root",
        afterBlockId: "check-child",
      },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "page-transfer:agent-session:same-page-primary",
    } as const;
    await expect(service.transferBlocks({
      ...samePageInput,
      target: { ...samePageInput.target, expectedVersion: targetCurrent.page.version + 1 },
    })).rejects.toBeInstanceOf(PageMutationVersionConflictError);
    await expect(service.transferBlocks({
      ...samePageInput,
      target: { ...samePageInput.target, expectedStateVector: new Uint8Array([9, 9]) },
    })).rejects.toBeInstanceOf(PageMutationStateVectorConflictError);
    await service.transferBlocks(samePageInput);
    const [samePageBinding] = await harness.sql<[{ target_page_id: string; target_expected_version: number }]>`
      SELECT target_page_id, target_expected_version
      FROM session_page_bindings WHERE session_id = 'moved-session'
    `;
    expect(samePageBinding).toEqual({
      target_page_id: "transfer-target",
      target_expected_version: 3,
    });
  }, 30_000);

  it("rejects a new transfer target that already exists without changing either page", async () => {
    await service.createPage({
      page: { id: "collision-source", title: "Collision source", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:collision-source",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("collision-moved", null, null, "paragraph", "Move")],
      },
    });
    await service.createPage({
      page: { id: "collision-target", title: "Existing target", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:collision-target",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("collision-existing", null, null, "paragraph", "Keep")],
      },
    });
    const sourceBefore = await service.getBrowserPage("collision-source");
    const targetBefore = await service.getBrowserPage("collision-target");

    await expect(service.transferBlocks({
      source: {
        pageId: "collision-source",
        expectedVersion: sourceBefore.page.version,
        expectedStateVector: decodeStateVector(sourceBefore.state_vector),
        blockIds: ["collision-moved"],
      },
      target: { kind: "new", pageId: "collision-target", title: "Must not overwrite" },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "page-transfer:agent-session:collision-target",
    })).rejects.toBeInstanceOf(PageMutationVersionConflictError);

    expect(await service.getBrowserPage("collision-source")).toEqual(sourceBefore);
    expect(await service.getBrowserPage("collision-target")).toEqual(targetBefore);
  }, 30_000);

  it("rolls back both pages when target CAS validation fails", async () => {
    await service.createPage({
      page: { id: "rollback-source", title: "Rollback source", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:rollback-source",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("rollback-block", null, null, "paragraph", "Stay")],
      },
    });
    await service.createPage({
      page: { id: "rollback-target", title: "Rollback target", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:rollback-target",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("rollback-anchor", null, null, "paragraph", "Anchor")],
      },
    });
    const sourceBefore = await service.getBrowserPage("rollback-source");
    const targetBefore = await service.getBrowserPage("rollback-target");
    const [countBefore] = await harness.sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM block_operations
    `;

    await expect(service.transferBlocks({
      source: {
        pageId: "rollback-source",
        expectedVersion: sourceBefore.page.version,
        expectedStateVector: decodeStateVector(sourceBefore.state_vector),
        blockIds: ["rollback-block"],
      },
      target: {
        kind: "existing",
        pageId: "rollback-target",
        expectedVersion: targetBefore.page.version,
        expectedStateVector: new Uint8Array([1, 2, 3]),
        parentId: null,
        afterBlockId: "rollback-anchor",
      },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "page-transfer:agent-session:rollback",
    })).rejects.toThrow();

    expect(await service.getBrowserPage("rollback-source")).toEqual(sourceBefore);
    expect(await service.getBrowserPage("rollback-target")).toEqual(targetBefore);
    const [countAfter] = await harness.sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM block_operations
    `;
    expect(countAfter).toEqual(countBefore);
  }, 30_000);

  it("extracts to a new page while replacing the source range with an exact mount", async () => {
    await service.createPage({
      page: { id: "extract-source", title: "Extract source", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:extract-source",
      initialCommand: {
        type: "batch_operations",
        operations: [
          createBlock("extract-before", null, null, "paragraph", "Before"),
          createBlock("extract-root", null, "extract-before", "paragraph", "Extracted"),
          createBlock("extract-child", "extract-root", null, "paragraph", "Child"),
          createBlock("extract-after", null, "extract-root", "paragraph", "After"),
        ],
      },
    });
    const sourceBefore = await service.getBrowserPage("extract-source");

    const extracted = await service.transferBlocks({
      source: {
        pageId: "extract-source",
        expectedVersion: sourceBefore.page.version,
        expectedStateVector: decodeStateVector(sourceBefore.state_vector),
        blockIds: ["extract-root"],
      },
      target: { kind: "new", pageId: "extracted-page", title: "Extracted page" },
      sourceMount: { title: "Extracted page", tempId: "extract-mount" },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "page-extract:agent-session:new-page",
    });

    expect(extracted.target_created).toBe(true);
    expect(extracted.source.blocks.map((block) => block.text)).toEqual([
      "Before", "[[Extracted page]]", "After",
    ]);
    expect(extracted.target.page).toMatchObject({ id: "extracted-page", title: "Extracted page", version: 1 });
    expect(extracted.target.blocks).toEqual([
      expect.objectContaining({ id: "extract-root", parent_id: null, text: "Extracted" }),
      expect.objectContaining({ id: "extract-child", parent_id: "extract-root", text: "Child" }),
    ]);
  }, 30_000);

  it("converges both live source and target Y.Docs after one cross-page transfer", async () => {
    const liveRepository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    const app = Fastify({ logger: false });
    const liveService = new PageYjsService({
      repository: liveRepository,
      auth: {
        authBearerToken: "service-token",
        environment: "production",
        dashboardAuthEnabled: false,
        verifyDashboardToken: async () => null,
      },
      logger: app.log,
    });
    registerPageYjsRoutes(app, {
      createService: () => liveService,
      authBearerToken: "service-token",
    });
    await liveService.createPage({
      page: { id: "live-transfer-source", title: "Live source", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:live-transfer-source",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("live-moved", null, null, "paragraph", "Live move")],
      },
    });
    await liveService.createPage({
      page: { id: "live-transfer-target", title: "Live target", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:live-transfer-target",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("live-anchor", null, null, "paragraph", "Anchor")],
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const sourceProvider = connectProvider(address, "live-transfer-source");
    const targetProvider = connectProvider(address, "live-transfer-target");
    try {
      await Promise.all([
        connectAndWaitForSync(sourceProvider),
        connectAndWaitForSync(targetProvider),
      ]);
      const sourceBefore = await liveService.getBrowserPage("live-transfer-source");
      const targetBefore = await liveService.getBrowserPage("live-transfer-target");
      const moved = await liveService.transferBlocks({
        source: {
          pageId: "live-transfer-source",
          expectedVersion: sourceBefore.page.version,
          expectedStateVector: decodeStateVector(sourceBefore.state_vector),
          blockIds: ["live-moved"],
        },
        target: {
          kind: "existing",
          pageId: "live-transfer-target",
          expectedVersion: targetBefore.page.version,
          expectedStateVector: decodeStateVector(targetBefore.state_vector),
          parentId: null,
          afterBlockId: "live-anchor",
        },
        actor: { actorKind: "agent", actorSessionId: "agent-session" },
        idempotencyKey: "page-transfer:agent-session:live-convergence",
      });

      await waitForAsync(async () => {
        const source = readPageYDocReplica("live-transfer-source", sourceProvider.document);
        const target = readPageYDocReplica("live-transfer-target", targetProvider.document);
        return source.page.mutationVersion === moved.source.page.version &&
          target.page.mutationVersion === moved.target.page.version &&
          !source.blocks.some((block) => block.id === "live-moved") &&
          target.blocks.some((block) => block.id === "live-moved");
      });
      expect(readPageYDocReplica("live-transfer-source", sourceProvider.document).blocks)
        .not.toContainEqual(expect.objectContaining({ id: "live-moved" }));
      expect(readPageYDocReplica("live-transfer-target", targetProvider.document).blocks)
        .toContainEqual(expect.objectContaining({ id: "live-moved", text: "Live move" }));
    } finally {
      await Promise.all([sourceProvider.destroy(), targetProvider.destroy()]);
      await app.close();
      await liveService.close();
    }
  }, 60_000);

  it("uses PostgreSQL CAS to reject concurrent new-target transfers from independent services", async () => {
    await service.createPage({
      page: { id: "db-race-source-a", title: "Race A", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:db-race-source-a",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("db-race-a", null, null, "paragraph", "A")],
      },
    });
    await service.createPage({
      page: { id: "db-race-source-b", title: "Race B", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:db-race-source-b",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("db-race-b", null, null, "paragraph", "B")],
      },
    });
    const repositoryA = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    const repositoryB = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    let targetChecks = 0;
    let releaseTargetChecks!: () => void;
    const bothChecked = new Promise<void>((resolve) => { releaseTargetChecks = resolve; });
    const gateNewTargetCheck = (repo: PageRepository) => {
      const original = repo.getPageYjsSnapshot.bind(repo);
      repo.getPageYjsSnapshot = async (documentName) => {
        const snapshot = await original(documentName);
        if (documentName === "page:db-race-target" && snapshot === null) {
          targetChecks += 1;
          if (targetChecks === 2) releaseTargetChecks();
          await bothChecked;
        }
        return snapshot;
      };
    };
    gateNewTargetCheck(repositoryA);
    gateNewTargetCheck(repositoryB);
    const serviceA = new PageYjsService({ repository: repositoryA });
    const serviceB = new PageYjsService({ repository: repositoryB });
    try {
      const [sourceA, sourceB] = await Promise.all([
        serviceA.getBrowserPage("db-race-source-a"),
        serviceB.getBrowserPage("db-race-source-b"),
      ]);
      const results = await Promise.allSettled([
        serviceA.transferBlocks({
          source: {
            pageId: "db-race-source-a",
            expectedVersion: sourceA.page.version,
            expectedStateVector: decodeStateVector(sourceA.state_vector),
            blockIds: ["db-race-a"],
          },
          target: { kind: "new", pageId: "db-race-target", title: "Race target A" },
          actor: { actorKind: "agent", actorSessionId: "agent-session" },
          idempotencyKey: "page-transfer:agent-session:db-race-a",
        }),
        serviceB.transferBlocks({
          source: {
            pageId: "db-race-source-b",
            expectedVersion: sourceB.page.version,
            expectedStateVector: decodeStateVector(sourceB.state_vector),
            blockIds: ["db-race-b"],
          },
          target: { kind: "new", pageId: "db-race-target", title: "Race target B" },
          actor: { actorKind: "agent", actorSessionId: "agent-session" },
          idempotencyKey: "page-transfer:agent-session:db-race-b",
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(PageMutationVersionConflictError);
      const target = await service.getBrowserPage("db-race-target");
      expect(target.blocks.map((block) => block.id).sort()).toEqual([
        results[0]?.status === "fulfilled" ? "db-race-a" : "db-race-b",
      ]);
      const sourceAfterA = await service.getBrowserPage("db-race-source-a");
      const sourceAfterB = await service.getBrowserPage("db-race-source-b");
      expect(sourceAfterA.blocks.some((block) => block.id === "db-race-a"))
        .toBe(results[0]?.status !== "fulfilled");
      expect(sourceAfterB.blocks.some((block) => block.id === "db-race-b"))
        .toBe(results[1]?.status !== "fulfilled");
    } finally {
      releaseTargetChecks();
      await Promise.all([serviceA.close(), serviceB.close()]);
    }
  }, 60_000);

  it("rejects concurrent different payloads sharing one logical transfer key", async () => {
    for (const suffix of ["a", "b"] as const) {
      await service.createPage({
        page: { id: `idempotency-source-${suffix}`, title: `Source ${suffix}`, dailyDate: null, metadata: {} },
        actor: { actorKind: "agent", actorSessionId: "agent-session" },
        idempotencyKey: `create_page:agent-session:idempotency-source-${suffix}`,
        initialCommand: {
          type: "batch_operations",
          operations: [createBlock(`idempotency-block-${suffix}`, null, null, "paragraph", suffix)],
        },
      });
    }
    await service.createPage({
      page: { id: "idempotency-target", title: "Idempotency target", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:idempotency-target",
      initialCommand: {
        type: "batch_operations",
        operations: [createBlock("idempotency-anchor", null, null, "paragraph", "anchor")],
      },
    });
    const repositoryA = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    const repositoryB = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    let commitArrivals = 0;
    let releaseCommits!: () => void;
    const bothAtCommit = new Promise<void>((resolve) => { releaseCommits = resolve; });
    const gateCommit = (repo: PageRepository) => {
      const original = repo.commitPageMutations.bind(repo);
      repo.commitPageMutations = async (input) => {
        commitArrivals += 1;
        if (commitArrivals === 2) releaseCommits();
        await bothAtCommit;
        return await original(input);
      };
    };
    gateCommit(repositoryA);
    gateCommit(repositoryB);
    const serviceA = new PageYjsService({ repository: repositoryA });
    const serviceB = new PageYjsService({ repository: repositoryB });
    try {
      const [sourceA, sourceB, target] = await Promise.all([
        serviceA.getBrowserPage("idempotency-source-a"),
        serviceB.getBrowserPage("idempotency-source-b"),
        serviceA.getBrowserPage("idempotency-target"),
      ]);
      const targetInput = {
        kind: "existing" as const,
        pageId: "idempotency-target",
        expectedVersion: target.page.version,
        expectedStateVector: decodeStateVector(target.state_vector),
        parentId: null,
        afterBlockId: "idempotency-anchor",
      };
      const logicalKey = "page-transfer:agent-session:shared-payload-key";
      const results = await Promise.allSettled([
        serviceA.transferBlocks({
          source: {
            pageId: "idempotency-source-a",
            expectedVersion: sourceA.page.version,
            expectedStateVector: decodeStateVector(sourceA.state_vector),
            blockIds: ["idempotency-block-a"],
          },
          target: targetInput,
          actor: { actorKind: "agent", actorSessionId: "agent-session" },
          idempotencyKey: logicalKey,
        }),
        serviceB.transferBlocks({
          source: {
            pageId: "idempotency-source-b",
            expectedVersion: sourceB.page.version,
            expectedStateVector: decodeStateVector(sourceB.state_vector),
            blockIds: ["idempotency-block-b"],
          },
          target: targetInput,
          actor: { actorKind: "agent", actorSessionId: "agent-session" },
          idempotencyKey: logicalKey,
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(PageMutationIdempotencyConflictError);
      const canonicalTarget = await service.getBrowserPage("idempotency-target");
      const movedIds = canonicalTarget.blocks.map((block) => block.id)
        .filter((id) => id.startsWith("idempotency-block-"));
      expect(movedIds).toEqual([
        results[0]?.status === "fulfilled" ? "idempotency-block-a" : "idempotency-block-b",
      ]);
      const sourceAfterA = await service.getBrowserPage("idempotency-source-a");
      const sourceAfterB = await service.getBrowserPage("idempotency-source-b");
      expect(sourceAfterA.blocks.some((block) => block.id === "idempotency-block-a"))
        .toBe(results[0]?.status !== "fulfilled");
      expect(sourceAfterB.blocks.some((block) => block.id === "idempotency-block-b"))
        .toBe(results[1]?.status !== "fulfilled");
    } finally {
      releaseCommits();
      await Promise.all([serviceA.close(), serviceB.close()]);
    }
  }, 60_000);

  it("does not change the live document when the database commit fails", async () => {
    const failing = new PageYjsService({
      repository: {
        getPageYjsSnapshot: repository.getPageYjsSnapshot.bind(repository),
        hasPageProjection: repository.hasPageProjection.bind(repository),
        getPageMutationByIdempotencyKey: repository.getPageMutationByIdempotencyKey.bind(repository),
        hasPageOperation: repository.hasPageOperation.bind(repository),
        getPageTimestamps: repository.getPageTimestamps.bind(repository),
        findPageIdByTitle: repository.findPageIdByTitle.bind(repository),
        findPageIdByDailyDate: repository.findPageIdByDailyDate.bind(repository),
        listPages: repository.listPages.bind(repository),
        getPageBacklinks: repository.getPageBacklinks.bind(repository),
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

  it("derives the omitted daily date in KST and returns the same page idempotently", async () => {
    const actor = { actorKind: "user" as const, actorUserId: "user@example.com" };
    const [first, second] = await Promise.all([
      service.getDailyPage({ actor }),
      service.getDailyPage({ actor }),
    ]);

    expect(first).toMatchObject({
      created: true,
      page: {
        id: "daily-page-1",
        daily_date: "2026-07-12",
        title: "2026년 7월 12일",
      },
      operation: {
        operation_type: "create_page",
        actor_kind: "user",
        actor_user_id: "user@example.com",
      },
    });
    expect(second).toMatchObject({
      created: false,
      page: { id: first.page.id, daily_date: "2026-07-12" },
    });
  }, 30_000);

  it("persists client edits that race a durable server mutation exactly once", async () => {
    const created = await service.createPage({
      page: { id: "page-race", title: "Before", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "agent-session" },
      idempotencyKey: "create_page:agent-session:race",
      initialCommand: {
        type: "batch_operations",
        operations: [{
          op: "create_block",
          tempId: "race-block",
          parentId: null,
          parentTempId: null,
          afterBlockId: null,
          afterTempId: null,
          blockType: "paragraph",
          text: "base",
          properties: {},
        }],
      },
    });
    const blockId = created.temp_id_mapping["race-block"]!;

    const app = Fastify({ logger: false });
    const raceService = new PageYjsService({
      repository,
      auth: {
        authBearerToken: "service-token",
        environment: "production",
        dashboardAuthEnabled: false,
        verifyDashboardToken: async () => null,
      },
      logger: app.log,
    });
    registerPageYjsRoutes(app, {
      createService: () => raceService,
      authBearerToken: "service-token",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const provider = connectProvider(address, "page-race");
    const originalCommit = repository.commitPageMutation.bind(repository);
    let releaseCommit!: () => void;
    let markCommitStarted!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commitStarted = new Promise<void>((resolve) => { markCommitStarted = resolve; });
    let operationSnapshot: Uint8Array | null = null;
    try {
      await connectAndWaitForSync(provider);
      repository.commitPageMutation = async (input) => {
        markCommitStarted();
        await commitBarrier;
        const result = await originalCommit(input);
        operationSnapshot = input.application.snapshot;
        return result;
      };
      const text = getEditableText(provider.document, blockId);
      text.insert(text.length, "-A");
      const mutation = raceService.mutatePage({
        pageId: "page-race",
        expectedVersion: 1,
        actor: { actorKind: "agent", actorSessionId: "agent-session" },
        idempotencyKey: "rename_page:agent-session:race",
        command: { type: "rename_page", title: "Renamed" },
      });
      await commitStarted;
      text.insert(text.length, "-B");
      releaseCommit();
      await mutation;

      await waitForAsync(async () => {
        const [row] = await harness.sql<[{ count: number }]>`
          SELECT COUNT(*)::int AS count
          FROM board_yjs_updates
          WHERE document_name = 'page:page-race'
        `;
        return row?.count === 1 &&
          raceService.getPersistenceDiagnostics().pendingUpdateDocuments === 0;
      });

      const finalSnapshot = await repository.getPageYjsSnapshot("page:page-race");
      const finalReplica = readPageYDocReplica(
        "page-race",
        raceService.decodeSnapshot(finalSnapshot!),
      );
      expect(finalReplica.page.title).toBe("Renamed");
      expect(finalReplica.blocks[0]?.text).toBe("base-A-B");
      const [updateRow] = await harness.sql<[{ update: Uint8Array }]>`
        SELECT update FROM board_yjs_updates
        WHERE document_name = 'page:page-race'
      `;
      const replay = raceService.decodeSnapshot(operationSnapshot!);
      Y.applyUpdate(replay, new Uint8Array(updateRow!.update));
      expect(readPageYDocReplica("page-race", replay).blocks[0]?.text).toBe("base-A-B");

      const reloadRepository = new PageRepository(
        createLiveDbSqlResolver({ sql: harness.liveSql }),
      );
      const reloadService = new PageYjsService({ repository: reloadRepository });
      try {
        const reloaded = await reloadService.getPage("page-race");
        expect(reloaded.page.title).toBe("Renamed");
        expect(reloaded.blocks[0]?.text).toBe("base-A-B");
      } finally {
        await reloadService.close();
      }
    } finally {
      repository.commitPageMutation = originalCommit;
      releaseCommit();
      await provider.destroy();
      await app.close();
    }
  }, 60_000);
});

function connectProvider(address: string, pageId: string): HocuspocusProvider {
  return new HocuspocusProvider({
    url: `${address.replace("http", "ws")}/yjs/page/${pageId}`,
    name: `page:${pageId}`,
    document: new Y.Doc(),
    token: "service-token",
    WebSocketPolyfill: WebSocket,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket });
}

function waitForSync(
  provider: HocuspocusProvider,
  timeoutMs = 30_000,
): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      provider.off("synced", onSynced);
      provider.off("authenticationFailed", onAuthenticationFailed);
    };
    const onSynced = () => {
      cleanup();
      resolve();
    };
    const onAuthenticationFailed = ({ reason }: { reason: string }) => {
      cleanup();
      reject(new Error(reason));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("provider sync timed out"));
    }, timeoutMs);
    provider.on("synced", onSynced);
    provider.on("authenticationFailed", onAuthenticationFailed);
    if (provider.isSynced) {
      onSynced();
    }
  });
}

async function connectAndWaitForSync(provider: HocuspocusProvider): Promise<void> {
  await waitForSync(provider);
}

function getEditableText(document: Y.Doc, blockId: string): Y.Text {
  const block = document.getMap<Y.Map<unknown>>("blocks").get(blockId);
  const text = block?.get("text");
  if (!(text instanceof Y.Text)) throw new Error("editable block text missing");
  return text;
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createBlock(
  id: string,
  parentId: string | null,
  afterBlockId: string | null,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
  collapsed = false,
) {
  return {
    op: "create_block" as const,
    id,
    tempId: id,
    parentId,
    parentTempId: null,
    afterBlockId,
    afterTempId: null,
    blockType,
    text,
    properties,
    collapsed,
  };
}

function decodeStateVector(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
