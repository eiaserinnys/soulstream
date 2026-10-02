import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { createBoardYDocSnapshot, readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
import { BoardYjsMoveRepository } from "../src/board-yjs/board_yjs_move_repository.js";
import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import { createLiveDbSqlResolver, type LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { SessionBoardMoveService } from "../src/session/session_board_move_service.js";

// Reuse the real BoardYjsService and disposable full-schema harness from bootstrap-scope tests.
let harness: FullSchemaPostgresHarness;
let board: BoardYjsService;
let repository: BoardYjsRepository;
let move: SessionBoardMoveService;
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
  repository = new BoardYjsRepository(resolver);
  for (const folderId of ["source","target"]) {
    const snapshot = createBoardYDocSnapshot({folderId, markdownDocuments: [], boardItems:
      folderId === "source" ? ["parent","root","child","grandchild","sibling"].map(itemId => ({
        id: `session:${itemId}`, folderId, itemType: "session" as const, itemId, x: 0, y: 0, metadata: {},
      })) : []});
    const doc = new Y.Doc(); Y.applyUpdate(doc,snapshot);
    await repository.syncBoardYjsReplica({folderId},readBoardYDocReplica({folderId},doc));
    await repository.storeBoardYjsSnapshot(`board-folder:${folderId}`,
      createBoardYDocSnapshot({folderId, markdownDocuments: [], boardItems:
        folderId === "source" ? ["parent","root","child","grandchild","sibling"].map(itemId => ({
          id: `session:${itemId}`, folderId, itemType: "session" as const,
          itemId, x: 0, y: 0, metadata: {},
        })) : []}), null);
  }
  move = new SessionBoardMoveService({
    repository: new BoardYjsMoveRepository(resolver),
    board: {withSessionBoardMoveApplications: (input,persist) => board.withSessionBoardMoveApplications(input,persist)},
    onCardsMoveCommitted: committed,
  });
  const logger = {info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn(),trace:vi.fn(),fatal:vi.fn(),child:()=>logger};
  board = new BoardYjsService({
    repository, logger: logger as never,
    moveSessionBoardItem: input => move.moveSessionBoardItem(input),
    auth: {authBearerToken:"test-token",environment:"production",dashboardAuthEnabled:false,resolveDashboardUserFromHeaders:async()=>null},
  });
}, 60000);
afterAll(async () => { await board?.close(); await harness?.cleanup(); });

it("moves overlapping three-level roots, assigned cards and Y.Doc projections in one commit", async () => {
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
  for (const folderId of ["source","target"]) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc,(await repository.getBoardYjsSnapshot(`board-folder:${folderId}`))!);
    const expected = folderId === "source" ? ["parent","sibling"] : ["child","grandchild","root"];
    expect(readBoardYDocReplica({folderId},doc).boardItems.map(item=>item.itemId).sort()).toEqual(expected);
    expect((await harness.sql`SELECT item_id FROM board_items WHERE folder_id=${folderId} ORDER BY item_id`).map(row=>row.item_id))
      .toEqual(expected);
  }
  expect(committed).toHaveBeenCalledTimes(1);
  expect(committed.mock.calls[0]![0]).toHaveLength(3);
});

it("rolls back sessions, cards and snapshots when a card move fails inside the transaction", async () => {
  await harness.sql`INSERT INTO folders(id,name) VALUES ('rejected','Rejected')`;
  await harness.sql.unsafe(`
    CREATE FUNCTION reject_card_move() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.folder_id = 'rejected' THEN RAISE EXCEPTION 'rejected card move'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_card_move BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION reject_card_move();
  `);
  const before = await harness.sql`SELECT name,snapshot FROM board_yjs_documents WHERE name <> 'board-folder:rejected' ORDER BY name`;
  committed.mockClear();
  await expect(move.moveSessionsToFolder(["root"], "rejected")).rejects.toThrow();
  expect(await harness.sql`SELECT name,snapshot FROM board_yjs_documents WHERE name <> 'board-folder:rejected' ORDER BY name`).toEqual(before);
  expect(await harness.sql`SELECT DISTINCT folder_id,version FROM cards WHERE id <> 'unrelated-card'`)
    .toEqual([{folder_id:"target",version:2}]);
  expect(committed).not.toHaveBeenCalled();
});
