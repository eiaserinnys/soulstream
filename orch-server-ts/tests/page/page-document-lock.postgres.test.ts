import { expect, it } from "vitest";
import { PageRepository } from "../../src/page/page_repository.js";
import { PageYjsService } from "../../src/page/page_service.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import { HandoverGate, guardMethods } from "../../src/runtime/handover_gate.js";
import { HandoverPostgres } from "../../src/runtime/handover_postgres.js";
import { createPagePostgresHarness } from "./page_postgres_harness.js";

it("hands a page to the next PostgreSQL lease owner without losing either edit", async () => {
  const harness = await createPagePostgresHarness();
  const repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
  const oldGate = new HandoverGate(), nextGate = new HandoverGate();
  const oldLock = new HandoverPostgres(harness.databaseUrl, oldGate);
  const nextLock = new HandoverPostgres(harness.databaseUrl, nextGate);
  const guarded = (gate: HandoverGate) => guardMethods(new PageYjsService({ repository, documentGate: gate }), gate,
    ["createPage", "mutatePage", "getPage", "getBrowserPage"]);
  const old = guarded(oldGate), next = guarded(nextGate);
  const actor = { actorKind: "agent" as const, actorSessionId: "agent-session" };
  try {
    await harness.sql`INSERT INTO sessions (session_id) VALUES ('agent-session')`;
    await oldLock.acquirePage();
    await old.createPage({
      page: { id: "handover-page", title: "Handover", dailyDate: null, metadata: {} }, actor,
      idempotencyKey: "create_page:agent-session:handover",
      initialCommand: { type: "batch_operations", operations: [{ op: "create_block", id: "block", tempId: "block",
        parentId: null, parentTempId: null, afterBlockId: null, afterTempId: null, blockType: "paragraph", text: "base", properties: {} }] },
    });
    const acquire = nextLock.acquirePage();
    let opened = false;
    const waiting = next.getPage("handover-page").then(page => { opened = true; return page; });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(opened).toBe(false);
    await old.mutatePage({ pageId: "handover-page", expectedVersion: 1, actor,
      idempotencyKey: "page:agent-session:old-edit", command: { type: "batch_operations", operations: [
        { op: "update_block_text", blockId: "block", text: "base-old" },
      ] } });
    await old.closeForHandover();
    await oldLock.releasePage();
    await acquire;
    expect((await waiting).blocks[0]!.text).toBe("base-old");
    await next.mutatePage({ pageId: "handover-page", expectedVersion: 2, actor,
      idempotencyKey: "page:agent-session:new-edit", command: { type: "batch_operations", operations: [
        { op: "update_block_text", blockId: "block", text: "base-old-new" },
      ] } });
    expect((await next.getPage("handover-page")).blocks[0]!.text).toBe("base-old-new");
    await expect(old.getPage("handover-page")).rejects.toMatchObject({ statusCode: 503 });
    await next.closeForHandover();
    await nextLock.releasePage();
  } finally { await Promise.all([old.close(), next.close()]); await Promise.all([oldLock.close(), nextLock.close()]); await harness.cleanup(); }
}, 60_000);
