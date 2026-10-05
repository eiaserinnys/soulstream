import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { createPagePostgresHarness,type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { readAssignedCardContext } from "../src/cards/assigned_card_context.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { CardMutationChange } from "../src/cards/card_control_plane_service.js";
import { buildCardChangeNotification } from "../src/cards/card_change_notification.js";

describe("bounded assigned cards and locked mutation snapshots",()=>{
  let h:PagePostgresHarness;
  beforeAll(async()=>{h=await createPagePostgresHarness();await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더')`;await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running'),('other','running'),('subtask','running')`;},60000);
  afterAll(async()=>await h?.cleanup());
  beforeEach(async()=>{await h.sql`DELETE FROM cards`;});
  it("includes completed and cancelled ownership, keeps activity times and excludes archive",async()=>{
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      VALUES ('owned','f','a','카드','원 지시','done','session','owner')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,archived,assignee_session_id)
      VALUES ('archive','f','b','보관',TRUE,'owner'),('foreign','f','c','타 담당',FALSE,'other')`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES
      ('i1','owned','user','comment','예전',NOW()-INTERVAL '2 minutes'),('i2','owned','user','comment','최신 커멘트',NOW())`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id,created_at)
      VALUES ('r1','owned','보고','html','<p>최신 보고</p>','owner',NOW()-INTERVAL '1 minute')`;
    const sql=createBoardYjsSqlAdapter(h.liveSql),tracked=vi.fn(sql);
    const snapshot=await readAssignedCardContext(tracked as unknown as typeof sql,'owner');
    expect(tracked).toHaveBeenCalledTimes(1);expect(snapshot.total).toBe(1);expect(snapshot.omitted).toBe(0);
    expect(snapshot.cards).toEqual([expect.objectContaining({id:'owned',status:'done',hasItems:false,latestCommentAt:expect.any(String),latestReportAt:expect.any(String)})]);
    expect(Date.parse(snapshot.cards[0]!.latestCommentAt!)).toBeGreaterThan(Date.parse(snapshot.cards[0]!.latestReportAt!));
    expect(snapshot.cards[0]).not.toHaveProperty('report');
    await h.sql`UPDATE cards SET status='cancelled' WHERE id='owned'`;
    expect(await readAssignedCardContext(sql,'owner')).toMatchObject({total:1,cards:[{id:'owned',status:'cancelled'}]});
    expect(await readAssignedCardContext(sql,'unassigned')).toMatchObject({total:0,cards:[]});
  });
  it("projects only whether the owned card has any check items",async()=>{
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id,items)
      VALUES ('empty-items','f','a','옛 카드','요청','running','session','owner','[]'::jsonb),
        ('has-items','f','b','새 카드','요청','running','session','owner','[{"id":1,"title":"결과"}]'::jsonb)`;
    const snapshot=await readAssignedCardContext(createBoardYjsSqlAdapter(h.liveSql),'owner');
    expect(Object.fromEntries(snapshot.cards.map(card=>[card.id,card.hasItems]))).toEqual({
      'empty-items':false,'has-items':true,
    });
  });
  it("does not treat card membership as session assignment",async()=>{
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      VALUES ('owned','f','a','담당 카드','요청','todo','session','owner')`;
    await h.sql`UPDATE sessions SET card_id='owned' WHERE session_id='subtask'`;
    const sql=createBoardYjsSqlAdapter(h.liveSql);

    expect(await readAssignedCardContext(sql,'owner')).toMatchObject({total:1,cards:[{id:'owned',status:'todo'}]});
    expect(await readAssignedCardContext(sql,'subtask')).toMatchObject({total:0,cards:[]});
  });
  it("captures state and owner under lock, independent of stale pre-lock read or post-commit reassignment",async()=>{
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_session_id) VALUES ('locked','f','100','경합','요청','todo','other')`;
    const changes:CardMutationChange[]=[];
    const service=new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql),{appendEventTx:async()=>0},undefined,c=>changes.push(c));
    await h.lockSql.begin(async tx=>{
      await tx`SELECT id FROM cards WHERE id='locked' FOR UPDATE`;
      // An in-flight mutation reads todo/other before it waits for this row lock.
      const pending=service.setCardStatus({cardId:'locked',actorKind:'user',actorSessionId:null,status:'running'});
      // Poll pg_stat_activity to prove the mutation has reached the card lock, rather than timing guesses.
      for(let i=0;i<100;i++) {const waiting=await h.peerSql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%cards%FOR UPDATE%'`;if(waiting.length)break;await new Promise(resolve=>setTimeout(resolve,10));if(i===99)throw Error('mutation did not wait for card lock');}
      await tx`UPDATE cards SET status='queued',assignee_session_id='owner' WHERE id='locked'`;
      // Complete after transaction COMMIT without waiting inside this transaction.
      return pending.then.bind(pending);
    }).then(async wait=>{await new Promise<void>((resolve,reject)=>wait(()=>resolve(),reject));});
    expect(changes[0]).toMatchObject({previousStatus:'queued',previousAssigneeSessionId:'owner',committedCard:{status:'running',assignee_session_id:'owner'}});
    await h.sql`UPDATE cards SET status='done',assignee_session_id='other' WHERE id='locked'`;
    expect(buildCardChangeNotification(changes[0]!)).toMatchObject({sessionId:'owner',text:expect.stringContaining('대기→실행 중')});
  });
});
