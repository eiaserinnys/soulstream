import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { createPagePostgresHarness,type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { readAssignedCardContext } from "../src/cards/assigned_card_context.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import type { CardMutationChange } from "../src/cards/card_control_plane_service.js";
import { buildCardChangeNotification } from "../src/cards/card_change_notification.js";

describe("bounded assigned cards and locked mutation snapshots",()=>{
  let h:PagePostgresHarness;
  beforeAll(async()=>{h=await createPagePostgresHarness();await h.sql`INSERT INTO folders(id,name) VALUES ('f','폴더')`;await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running'),('other','running')`;},60000);
  afterAll(async()=>await h?.cleanup());
  it("queries active ownership and latest activity times, limits rows and removes completed cards on next read",async()=>{
    for(let i=0;i<15;i++) await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      VALUES (${`c${i}`},'f',${String(i)},'카드','원 지시','todo','session','owner')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,archived,assignee_session_id) VALUES
      ('done','f','99','완료','비밀','done',FALSE,'owner'),('cancel','f','98','취소','비밀','cancelled',FALSE,'owner'),
      ('archive','f','97','보관','비밀','running',TRUE,'owner'),('foreign','f','96','타 담당','비밀','running',FALSE,'other')`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES ('i1','c14','user','comment','예전',NOW()-INTERVAL '2 minutes'),('i2','c14','user','comment','최신 커멘트',NOW())`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id,created_at) VALUES ('r1','c14','보고','html','<p>최신 보고</p>','owner',NOW()-INTERVAL '1 minute')`;
    await h.sql`UPDATE cards SET version=17 WHERE id='c14'`;
    const sql=createBoardYjsSqlAdapter(h.liveSql),tracked=vi.fn(sql);
    const snapshot=await readAssignedCardContext(tracked as unknown as typeof sql,'owner');
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(snapshot.total).toBe(15);expect(snapshot.cards).toHaveLength(12);
    expect(snapshot.cards).toContainEqual(expect.objectContaining({
      id:'c14',title:'카드',status:'todo',
      latestCommentAt:expect.any(String),latestReportAt:expect.any(String),
    }));
    const current=snapshot.cards.find(card=>card.id==='c14')!;
    expect(Date.parse(current.latestCommentAt!)).toBeGreaterThan(Date.parse(current.latestReportAt!));
    expect(current).not.toHaveProperty('version');
    expect(current).not.toHaveProperty('instruction');
    expect(current).not.toHaveProperty('report');
    expect(snapshot.cards.some(c=>['done','cancel','archive','foreign'].includes(c.id))).toBe(false);
    await h.sql`UPDATE cards SET status='done' WHERE id='c14'`;
    const next=await readAssignedCardContext(sql,'owner');expect(next.total).toBe(14);expect(next.cards.some(c=>c.id==='c14')).toBe(false);
    expect(await readAssignedCardContext(sql,'unassigned')).toMatchObject({total:0,cards:[]});
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
