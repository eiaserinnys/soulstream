import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlannerRepository } from "../src/planner/planner_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("folder planner PostgreSQL", () => {
  let h: PagePostgresHarness; let repo: PlannerRepository;
  beforeAll(async () => {
    h = await createPagePostgresHarness(); repo = new PlannerRepository(createLiveDbSqlResolver({ sql: h.liveSql }));
    for (const [n, enabled] of [["a", false], ["b", true], ["claude", true]] as const) {
      await h.sql`INSERT INTO pages(id,title,version,metadata) VALUES (${`p-${n}`},${`Folder ${n}`},1,'{"starred":true}')`;
      await h.sql`INSERT INTO folders(id,name,project_page_id,checklist_enabled) VALUES (${n},${n},${`p-${n}`},${enabled})`;
      await h.sql`INSERT INTO planner_starred_page_order(page_id,position) VALUES (${`p-${n}`},${n==='a'?0:n==='b'?1:2})`;
    }
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,status) VALUES ('i','b','a0','Card','done')`;
    await h.sql`INSERT INTO pages(id,title,daily_date,version) VALUES ('daily','2026-09-30','2026-09-30',1)`;
    await h.sql`INSERT INTO blocks(id,page_id,position_key,block_type,text_plain) VALUES ('mount','daily','a0','paragraph','[[Folder a]]'),('memo','daily','a1','paragraph','memo')`;
    await h.sql`INSERT INTO block_links(id,source_block_id,link_kind,ordinal,source_start,source_end,target_page_id,target_title,target_title_key) VALUES ('l','mount','mount',0,0,12,'p-a','Folder a','folder a')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id,status) VALUES ('session','b','idle')`;
    await h.sql`INSERT INTO blocks(id,page_id,position_key,block_type,properties) VALUES ('ref','p-b','a0','session_ref','{"sessionId":"session","primary":true}')`;
  },60_000);
  afterAll(async () => { await h?.cleanup(); });
  it("lists ordinary and checklist folders while excluding system folders", async () => {
    const first = await repo.getStarredFolders({ limit: 1 });
    expect(first.items.map(x=>x.folder.id)).toEqual(["a"]); expect(first.items[0]?.folder.checklistEnabled).toBe(false);
    const second = await repo.getStarredFolders({ limit: 1, cursor: first.nextCursor! });
    expect(second.items.map(x=>x.folder.id)).toEqual(["b"]); expect(second.nextCursor).toBeNull();
    expect(second.items[0]).toMatchObject({ itemTotal: 1, completedItemCount: 1, itemCounts: { done: 1 } });
  });
  it("uses page mounts for today and returns one session despite two ownership references", async () => {
    expect(await repo.getToday("2026-09-30")).toMatchObject({ folders: [{ folder: { id: "a" } }], memoBlocks: [{ id: "memo" }] });
    expect((await repo.getSessions("b", { limit: 20 })).items.map(x=>x.agentSessionId)).toEqual(["session"]);
    expect(await repo.getFolder("b", { limit: 20 })).toMatchObject({ folder: { id: "b" }, cards: [{ id: "i" }] });
  });
  it("reorders by page ID and detects stale star membership", async () => {
    expect(await repo.moveStarredFolder({ pageId: "p-b", beforePageId: "p-a" })).toMatchObject({ changed: true });
    expect((await repo.getStarredFolders({ limit: 20 })).items.map(x=>x.folder.id)).toEqual(["b","a"]);
    await h.sql`UPDATE folders SET archived=TRUE WHERE id='b'`;
    await expect(repo.moveStarredFolder({ pageId: "p-b", beforePageId: null })).rejects.toThrow("active starred folder");
  });
});
