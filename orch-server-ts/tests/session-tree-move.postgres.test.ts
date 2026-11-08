import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { SessionFolderMoveRepository } from "../src/session/session_folder_move_repository.js";
import { SessionFolderMoveService } from "../src/session/session_folder_move_service.js";
import { createLiveDbSqlResolver, type LivePostgresSql } from "../src/runtime/live_db_sql.js";

// Reuse the disposable full-schema PostgreSQL harness.
let harness: FullSchemaPostgresHarness;
let move: SessionFolderMoveService;
const committed = vi.fn();
beforeAll(async () => {
  harness = await createFullSchemaPostgresHarness();
  await harness.sql`INSERT INTO folders(id,name) VALUES ('source','Source'),('target','Target')`;
  await harness.sql`INSERT INTO sessions(session_id,folder_id,caller_session_id)
    VALUES ('parent','source',NULL),('root','source','parent'),('child','source','root'),
    ('grandchild','source','child'),('sibling','source','parent')`;
  await harness.sql`INSERT INTO cards(id,folder_id,position_key,title,assignee_kind,assignee_session_id,status)
    VALUES ('root-card','source','a0','Root','session','root','running'),
    ('child-card','source','a1','Child','session','child','review'),
    ('grandchild-card','source','a2','Grandchild','session','grandchild','blocked'),
    ('unrelated-card','source','a3','Other','session','sibling','todo')`;
  await harness.sql`UPDATE sessions SET card_id='unrelated-card' WHERE session_id='root'`;
  const resolver = createLiveDbSqlResolver({sql: harness.sql as unknown as LivePostgresSql});
  move = new SessionFolderMoveService({
    repository: new SessionFolderMoveRepository(resolver),
    onCardsMoveCommitted: committed,
  });
}, 60000);
afterAll(async () => { await harness?.cleanup(); });

it("moves overlapping three-level roots and assigned cards in one commit", async () => {
  const before = await harness.sql`SELECT * FROM cards WHERE id='unrelated-card'`;
  const result = await move.moveSessionsToFolder(["root","child"], "target");
  expect(new Set(result.sessionIds)).toEqual(new Set(["root","child","grandchild"]));
  expect(await harness.sql`SELECT session_id FROM sessions WHERE folder_id='target' ORDER BY session_id`)
    .toEqual(["child","grandchild","root"].map(session_id=>({session_id})));
  expect(await harness.sql`SELECT id,folder_id,status,version FROM cards WHERE id <> 'unrelated-card' ORDER BY id`)
    .toEqual([
      {id:"child-card",folder_id:"target",status:"review",version:2},
      {id:"grandchild-card",folder_id:"target",status:"blocked",version:2},
      {id:"root-card",folder_id:"target",status:"running",version:2},
    ]);
  expect(await harness.sql`SELECT * FROM cards WHERE id='unrelated-card'`).toEqual(before);
  expect(await harness.sql`SELECT card_id,caller_session_id FROM sessions WHERE session_id='root'`)
    .toEqual([{card_id:"unrelated-card",caller_session_id:"parent"}]);
  expect(await harness.sql`SELECT target_id,operation_type FROM folder_operations ORDER BY target_id`)
    .toEqual(["child-card","grandchild-card","root-card"].map(target_id=>({target_id,operation_type:"move_card"})));
  expect(committed).toHaveBeenCalledTimes(1);
  expect(committed.mock.calls[0]![0]).toHaveLength(3);
});

it("rolls back sessions and cards when a card move fails inside the transaction", async () => {
  await harness.sql`INSERT INTO folders(id,name) VALUES ('rejected','Rejected')`;
  await harness.sql.unsafe(`
    CREATE FUNCTION reject_card_move() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.folder_id = 'rejected' THEN RAISE EXCEPTION 'rejected card move'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_card_move BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION reject_card_move();
  `);
  committed.mockClear();
  await expect(move.moveSessionsToFolder(["root"], "rejected")).rejects.toThrow();
  expect(await harness.sql`SELECT DISTINCT folder_id,version FROM cards WHERE id <> 'unrelated-card'`)
    .toEqual([{folder_id:"target",version:2}]);
  expect(await harness.sql`SELECT DISTINCT folder_id FROM sessions WHERE session_id IN ('root','child','grandchild')`)
    .toEqual([{folder_id:"target"}]);
  expect(await harness.sql`SELECT item_id FROM board_items WHERE folder_id='rejected'`).toEqual([]);
  expect(committed).not.toHaveBeenCalled();
});

it("returns the same success result without changing sessions or cards", async () => {
  const sessionRows = await harness.sql`SELECT * FROM sessions ORDER BY session_id`;
  const cardRows = await harness.sql`SELECT * FROM cards ORDER BY id`;
  const operationRows = await harness.sql`SELECT * FROM folder_operations ORDER BY id`;
  committed.mockClear();
    await expect(move.moveSessionsToFolder(["root", "child"], "target")).resolves.toEqual({
      count: 3, sessionIds: ["child", "grandchild", "root"], didCommit: false,
    });
    expect(await harness.sql`SELECT * FROM sessions ORDER BY session_id`).toEqual(sessionRows);
    expect(await harness.sql`SELECT * FROM cards ORDER BY id`).toEqual(cardRows);
    expect(await harness.sql`SELECT * FROM folder_operations ORDER BY id`).toEqual(operationRows);
    expect(committed).not.toHaveBeenCalled();
});

it("rejects an unassigned destination for a tree with assigned cards without a partial move", async () => {
  const before = await harness.sql`SELECT session_id,folder_id FROM sessions ORDER BY session_id`;
  committed.mockClear();
  await expect(move.moveSessionsToFolder(["root"],null)).rejects.toMatchObject({statusCode:422});
  expect(await harness.sql`SELECT session_id,folder_id FROM sessions ORDER BY session_id`).toEqual(before);
  expect(committed).not.toHaveBeenCalled();
});

it.each(["child", "card"])("moves when only the %s DB assignment differs from the target folder", async different => {
  if (different === "child") await harness.sql`UPDATE sessions SET folder_id='source' WHERE session_id='child'`;
  else await harness.sql`UPDATE cards SET folder_id='source' WHERE id='root-card'`;
  committed.mockClear();
  await move.moveSessionsToFolder(["root"], "target");
  expect(await harness.sql`SELECT DISTINCT folder_id FROM sessions WHERE session_id IN ('root','child','grandchild')`)
    .toEqual([{ folder_id: "target" }]);
  expect(await harness.sql`SELECT DISTINCT folder_id FROM cards WHERE id <> 'unrelated-card'`)
    .toEqual([{ folder_id: "target" }]);
  expect(committed).toHaveBeenCalledOnce();
});
