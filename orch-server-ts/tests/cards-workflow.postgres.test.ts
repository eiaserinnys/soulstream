import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { executeCardOperation } from "../src/cards/card_operations.js";
import { registerFolderRoutes, type FolderRouteOptions } from "../src/folders/folder_routes.js";
import { SqlFolderProjectIdentityRepository } from "../src/folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "../src/folders/folder_project_identity_service.js";
import { executeFolderOperation } from "../src/folders/folder_operations.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";

// Same disposable PostgreSQL harness as the existing folder identity integration tests.
describe("cards storage, HTTP and planner", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let sequence = 0;
  const events: Array<{ cardId: string; folderId: string }> = [];
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const agent = { actorKind: "agent" as const, actorSessionId: "card-agent" };
  const key = () => `card-test:${++sequence}`;
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('cards-a','A'),('cards-b','B')`;
    await h.sql`INSERT INTO sessions(session_id,folder_id,status) VALUES ('card-agent','cards-a','running')`;
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), {
      appendEventTx: async (sql,p) => {
        const rows=await sql<{ id:number }[]>`INSERT INTO events(session_id,id,event_type,payload,dedupe_key)
          SELECT ${p.sessionId},COALESCE(max(id),0)+1,${p.eventType},${sql.json(JSON.parse(p.payload))},${p.dedupeKey ?? null}
          FROM events WHERE session_id=${p.sessionId} RETURNING id`;
        return rows[0]!.id;
      },
    }, { emitFolderUpdated: async () => {}, emitCardUpdated: async (cardId,folderId) => { events.push({ cardId,folderId }); } });
  },60_000);
  afterAll(async () => { await h?.cleanup(); });

  it("rejects agent done and reportless review, then accepts evidence and human completion", async () => {
    const made=await cards.createCard({ ...human,folderId:'cards-a',title:'검증',request:'고정 원문',idempotencyKey:key() });
    let c=made.snapshot.cards.find(x=>x.id === made.operation.target_id)!;
    await cards.setCardStatus({ ...human,cardId:c.id,status:'running',expectedVersion:c.version,idempotencyKey:key() });
    await expect(cards.setCardStatus({ ...agent,cardId:c.id,status:'done',idempotencyKey:key() })).rejects.toThrow(/human/i);
    await expect(cards.setCardStatus({ ...agent,cardId:c.id,status:'review',idempotencyKey:key() })).rejects.toThrow(/report/i);
    expect((await cards.getCard(c.id))!.card.status).toBe('running');
    const reportKey=key();
    await cards.addReport({ ...agent,cardId:c.id,title:'첫 증거',format:'markdown',body:'증거',idempotencyKey:reportKey });
    expect((await cards.addReport({ ...agent,cardId:c.id,title:'첫 증거',format:'markdown',body:'증거',idempotencyKey:reportKey })).idempotent).toBe(true);
    await cards.addReport({ ...agent,cardId:c.id,title:'최종 증거',format:'html',body:'<p>통과</p>',idempotencyKey:key() });
    expect((await cards.listReports(c.id)).map(r=>r.title)).toEqual(['최종 증거','첫 증거']);
    await cards.setCardStatus({ ...agent,cardId:c.id,status:'review',idempotencyKey:key() });
    await cards.setCardStatus({ ...human,cardId:c.id,status:'done',idempotencyKey:key() });
    expect((await cards.getCard(c.id))!.card).toMatchObject({ status:'done',request:'고정 원문',completed_kind:'user',completed_user_id:human.actorUserId });
    await expect(executeCardOperation(cards,'update_card',{ request:'변조',expectedVersion:1,idempotencyKey:key() },c.id,human)).rejects.toThrow();
    expect(events).toContainEqual({ cardId:c.id,folderId:'cards-a' });
  });

  it("keeps unanswered questions blocked and resumes only after the human answers all", async () => {
    const made=await cards.createCard({ ...human,folderId:'cards-a',title:'질문',request:'',idempotencyKey:key() });
    const id=made.operation.target_id;
    await cards.setCardStatus({ ...human,cardId:id,status:'running',idempotencyKey:key() });
    await cards.askQuestion({ ...agent,cardId:id,text:'결정?',options:['진행','중단'],idempotencyKey:key() });
    await cards.askQuestion({ ...human,cardId:id,text:'추가 확인?',idempotencyKey:key() });
    const q=(await cards.getCard(id))!.questions;
    await expect(cards.setCardStatus({ ...human,cardId:id,status:'done',idempotencyKey:key() })).rejects.toThrow(/questions/i);
    await expect(cards.answerQuestion({ ...agent,cardId:id,questionId:String(q[0]!.id),answer:'진행',idempotencyKey:key() })).rejects.toThrow(/human/i);
    await cards.answerQuestion({ ...human,cardId:id,questionId:String(q[0]!.id),answer:'진행',idempotencyKey:key() });
    expect((await cards.getCard(id))!.card.status).toBe('blocked');
    await cards.answerQuestion({ ...human,cardId:id,questionId:String(q[1]!.id),answer:'확인',idempotencyKey:key() });
    expect((await cards.getCard(id))!.card).toMatchObject({ status:'running',blocked_kind:null });
    expect((await cards.getCard(id))!.questions[0]).toMatchObject({ answered_by:human.actorUserId,answer:'진행' });
  });

  it("moves cards, replays the move, orders the global queue and keeps the session card link", async () => {
    const first=await cards.createCard({ ...human,folderId:'cards-a',title:'첫',request:'',queue:true,idempotencyKey:key() });
    const second=await cards.createCard({ ...human,folderId:'cards-b',title:'둘째',request:'',queue:true,idempotencyKey:key() });
    const id=first.operation.target_id;
    await h.sql`UPDATE sessions SET card_id=${id} WHERE session_id='card-agent'`;
    const moveKey=key();
    const moved=await cards.moveCard({ ...human,cardId:id,folderId:'cards-b',expectedVersion:1,idempotencyKey:moveKey });
    expect(moved.snapshot.cards.map(c=>c.id)).toEqual([second.operation.target_id,id]);
    expect((await cards.moveCard({ ...human,cardId:id,folderId:'cards-b',expectedVersion:1,idempotencyKey:moveKey })).idempotent).toBe(true);
    await cards.reorderQueue({ ...human,cardId:second.operation.target_id,afterCardId:null,expectedVersion:1,idempotencyKey:key() });
    expect((await h.sql`SELECT id FROM cards WHERE status='queued' ORDER BY queue_position_key COLLATE "C"`).map(r=>r.id)).toEqual([second.operation.target_id,id]);
    expect((await cards.getCard(id))!.sessions).toEqual([expect.objectContaining({ session_id:'card-agent',card_id:id })]);
    expect(events).toContainEqual({ cardId:id,folderId:'cards-b' });
    await expect(cards.patchCard({ ...human,cardId:id,title:'낡은 버전',expectedVersion:1,idempotencyKey:key() })).rejects.toMatchObject({ statusCode:409 });
  });

  it("preserves folder status with cards instead of sections", async () => {
    const resolver=createLiveDbSqlResolver({ sql:h.liveSql });
    const identity=new FolderProjectIdentityService({ repository:new SqlFolderProjectIdentityRepository(resolver),
      withBoardApplication:async (_input,persist)=>persist([]),hydratePage:async ()=>undefined });
    const services={ identity,cards };
    await executeFolderOperation(services,'set_folder_status',{ status:'completed',expectedVersion:1,idempotencyKey:key() },{ folderId:'cards-a' },human);
    const snapshot=(await cards.getFolder('cards-a'))!;
    expect(snapshot.folder).toMatchObject({ status:'completed',completed_kind:'user',completed_session_id:null });
    expect(snapshot.cards.length).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty('sections');
  });

  it("enforces HTTP actors, immutable requests, folder access and retired endpoint removal", async () => {
    const app=Fastify();
    const options={ provider:{ listFolders:()=>[{id:'cards-a'},{id:'cards-b'}],listSessionAssignments:()=>({}) },
      accessProvider:{ resolveAccess:()=>({restricted:true,allowedFolderIds:['cards-a']}) },resolveDashboardUserId:()=>human.actorUserId,
      cardServiceProvider:async ()=>cards,authBearerToken:'service-test',environment:'production' } satisfies FolderRouteOptions;
    registerFolderRoutes(app,options);
    try {
      const created=await app.inject({ method:'POST',url:'/api/cards',payload:{folderId:'cards-a',title:'HTTP',request:'원문',idempotencyKey:key()} });
      expect(created.statusCode).toBe(201);const id=created.json().card.id;
      const statusPayload={status:'running',expectedVersion:1,idempotencyKey:key()};
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/status`,payload:statusPayload})).statusCode).toBe(200);
      const headers={ authorization:'Bearer service-test','x-soulstream-agent-session-id':'card-agent' };
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/status`,headers,payload:{status:'done',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(422);
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/status`,headers,payload:{status:'review',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(422);
      expect((await app.inject({method:'PATCH',url:`/api/cards/${id}`,payload:{request:'수정',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(422);
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/move`,payload:{folderId:'cards-b',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(403);
      expect((await app.inject(`/api/cards/${id}`)).json()).toMatchObject({card:{id,folderId:'cards-a',request:'원문'},reports:[],questions:[],sessions:[]});
      expect((await app.inject('/api/folders/cards-a')).json()).toHaveProperty('cards');
      expect((await app.inject({method:'POST',url:'/api/folders/cards-a/checklist/items',payload:{}})).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("exposes review and every blocked kind in attention with running and globally ordered queued cards on today", async () => {
    await h.sql`INSERT INTO pages(id,title,daily_date,version) VALUES ('card-day','Today','2026-09-30',1),('card-page-a','A',NULL,1),('card-page-b','B',NULL,1)`;
    await h.sql`UPDATE folders SET project_page_id=CASE id WHEN 'cards-a' THEN 'card-page-a' ELSE 'card-page-b' END WHERE id IN ('cards-a','cards-b')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,status,blocked_kind) VALUES
      ('attention-review','cards-a','z1','Review','review',NULL),('attention-question','cards-a','z2','Question','blocked','question'),
      ('attention-report','cards-a','z3','No report','blocked','no_report'),('attention-limit','cards-a','z4','Limit','blocked','limit')`;
    const planner=new PlannerRepository(createLiveDbSqlResolver({ sql:h.liveSql }));
    const today=(await planner.getToday('2026-09-30'))!;
    expect(today.attention.map(c=>c.id).sort()).toEqual(['attention-limit','attention-question','attention-report','attention-review']);
    expect(today.running.length).toBeGreaterThan(0);
    expect(today.queued.map(c=>c.title)).toEqual(['둘째','첫']);
    expect((await planner.getFolder('cards-a',{limit:10}))!).toHaveProperty('cards');
  });
});
