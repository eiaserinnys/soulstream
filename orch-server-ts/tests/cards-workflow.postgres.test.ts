import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  beforeEach(async () => { await h.sql`UPDATE cards SET archived=TRUE WHERE assignee_session_id IS NOT NULL`; });
  afterAll(async () => { await h?.cleanup(); });

  it("accepts assigned agent completion and reportless review, with independent reports", async () => {
    const made=await cards.createCard({ ...human,folderId:'cards-a',title:'검증',request:'고정 원문',assignee:{kind:'session',sessionId:agent.actorSessionId},idempotencyKey:key() });
    let c=made.snapshot.cards.find(x=>x.id === made.operation.target_id)!;
    await cards.setCardStatus({ ...human,cardId:c.id,status:'running',expectedVersion:c.version,idempotencyKey:key() });
    await cards.setCardStatus({ ...agent,cardId:c.id,status:'done',idempotencyKey:key() });
    await cards.setCardStatus({ ...agent,cardId:c.id,status:'review',idempotencyKey:key() });
    expect((await cards.getCard(c.id))!.card.status).toBe('review');
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

  it("keeps question waiting until all answers arrive when no one moves the card", async () => {
    const made=await cards.createCard({ ...human,folderId:'cards-a',title:'질문',request:'',idempotencyKey:key() });
    const id=made.operation.target_id;
    await cards.setCardStatus({ ...human,cardId:id,status:'running',idempotencyKey:key() });
    await cards.askQuestion({ ...agent,cardId:id,text:'결정?',options:['진행','중단'],idempotencyKey:key() });
    await cards.askQuestion({ ...human,cardId:id,text:'추가 확인?',idempotencyKey:key() });
    await cards.addReport({ ...agent,cardId:id,title:'작업 보고',format:'markdown',body:'보고',idempotencyKey:key() });
    expect((await cards.getCard(id))!.card.status).toBe('blocked');
    const q=(await cards.getCard(id))!.questions;
    await expect(cards.answerQuestion({ ...agent,cardId:id,questionId:String(q[0]!.id),answer:'진행',idempotencyKey:key() })).rejects.toThrow(/human/i);
    await cards.answerQuestion({ ...human,cardId:id,questionId:String(q[0]!.id),answer:'진행',idempotencyKey:key() });
    expect((await cards.getCard(id))!.card.status).toBe('blocked');
    await cards.answerQuestion({ ...human,cardId:id,questionId:String(q[1]!.id),answer:'확인',idempotencyKey:key() });
    expect((await cards.getCard(id))!.card).toMatchObject({ status:'running',blocked_kind:null });
    expect((await cards.getCard(id))!.questions[0]).toMatchObject({ answered_by:human.actorUserId,answer:'진행' });
  });

  it.each(['todo','queued','running','review','done','cancelled'] as const)("allows human %s with an open question and preserves that state after a late answer", async status => {
    const made=await cards.createCard({ ...human,folderId:'cards-a',title:'질문 이후 이동',request:'',idempotencyKey:key() });
    const id=made.operation.target_id;
    await cards.setCardStatus({ ...human,cardId:id,status:'running',idempotencyKey:key() });
    await cards.askQuestion({ ...agent,cardId:id,text:'결정?',idempotencyKey:key() });
    await cards.addReport({ ...agent,cardId:id,title:'보고',format:'markdown',body:'증거',idempotencyKey:key() });
    await cards.setCardStatus({ ...human,cardId:id,status,idempotencyKey:key() });
    const before=(await cards.getCard(id))!;
    expect(before.card.status).toBe(status);
    expect(before.questions[0]!.answer).toBeNull();
    await cards.answerQuestion({ ...human,cardId:id,questionId:String(before.questions[0]!.id),answer:'진행',idempotencyKey:key() });
    const after=(await cards.getCard(id))!;
    expect(after.card).toMatchObject({status,queue_position_key:before.card.queue_position_key,completed_at:before.card.completed_at});
    expect(after.questions[0]).toMatchObject({answer:'진행',answered_by:human.actorUserId});
    await h.sql`DELETE FROM cards WHERE id=${id}`;
  });

  it("records a late answer on an already completed card without reopening it",async()=>{
    const made=await cards.createCard({...human,folderId:'cards-a',title:'이미 완료',request:'',idempotencyKey:key()});
    const id=made.operation.target_id;
    await cards.setCardStatus({...human,cardId:id,status:'done',idempotencyKey:key()});
    await h.sql`INSERT INTO card_questions(id,card_id,text) VALUES('late-done',${id},'남은 질문')`;
    await cards.answerQuestion({...human,cardId:id,questionId:'late-done',answer:'확인',idempotencyKey:key()});
    expect((await cards.getCard(id))!.card.status).toBe('done');
    await h.sql`DELETE FROM cards WHERE id=${id}`;
  });

  it.each(['todo','queued','blocked','question'] as const)("accepts an assigned session's %s review over HTTP and clears queue/block metadata", async (from) => {
    const made=await cards.createCard({ ...human,folderId:'cards-a',title:'완료 보고 검수',request:'원문',
      queue:from !== 'todo',assignee:{kind:'session',sessionId:agent.actorSessionId},idempotencyKey:key() });
    const id=made.operation.target_id;
    if (from === 'blocked') await cards.setCardStatus({ ...human,cardId:id,status:'blocked',
      blockedKind:'limit',blockedDetail:'이전 한도',idempotencyKey:key() });
    if (from === 'question') {
      await cards.setCardStatus({...human,cardId:id,status:'running',idempotencyKey:key()});
      await cards.askQuestion({...agent,cardId:id,text:'미답 질문',idempotencyKey:key()});
    }
    const expectedStatus=from === 'question' ? 'blocked' : from;
    let before=(await cards.getCard(id))!.card;
    expect(before.status).toBe(expectedStatus);
    if (from === 'queued' || from === 'blocked') expect(before.queue_position_key).not.toBeNull();
    const app=Fastify();
    registerFolderRoutes(app,{
      provider:{listFolders:()=>[{id:'cards-a'}],listSessionAssignments:()=>({})},
      accessProvider:{resolveAccess:()=>({restricted:true,allowedFolderIds:['cards-a']})},
      resolveDashboardUserId:()=>human.actorUserId,cardServiceProvider:async()=>cards,
      authBearerToken:'service-test',environment:'production',
    });
    const headers={authorization:'Bearer service-test','x-soulstream-agent-session-id':agent.actorSessionId};
    const review=()=>app.inject({method:'POST',url:`/api/cards/${id}/status`,headers,
      payload:{status:'review',expectedVersion:before.version,idempotencyKey:key()}});
    try {
      const reportless=await review();
      expect(reportless.statusCode).toBe(200);
      expect((await cards.getCard(id))!.card).toMatchObject({status:"review",version:before.version+1});
      await cards.addReport({ ...agent,cardId:id,title:'최종 보고',format:'markdown',body:'작업 증거',idempotencyKey:key() });
      before=(await cards.getCard(id))!.card;
      const accepted=await review();
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().card).toMatchObject({status:'review',version:before.version+1,
        queuePositionKey:null,blockedKind:null,blockedDetail:null});
      const stored=await app.inject(`/api/cards/${id}`);
      expect(stored.json().card).toMatchObject({status:'review',version:before.version+1,
        assigneeSessionId:agent.actorSessionId,queuePositionKey:null,blockedKind:null,blockedDetail:null});
      expect(stored.json().reports).toHaveLength(1);
    } finally {
      await app.close();
      await h.sql`DELETE FROM cards WHERE id=${id}`;
    }
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
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/status`,headers,payload:{status:'done',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/status`,headers,payload:{status:'review',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(403);
      expect((await app.inject({method:'PATCH',url:`/api/cards/${id}`,payload:{request:'수정',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(422);
      expect((await app.inject({method:'POST',url:`/api/cards/${id}/move`,payload:{folderId:'cards-b',expectedVersion:2,idempotencyKey:key()}})).statusCode).toBe(403);
      expect((await app.inject(`/api/cards/${id}`)).json()).toMatchObject({card:{id,folderId:'cards-a',request:'원문'},reports:[],questions:[],sessions:[]});
      expect((await app.inject('/api/folders/cards-a')).json()).toHaveProperty('cards');
      expect((await app.inject({method:'POST',url:'/api/folders/cards-a/checklist/items',payload:{}})).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("returns linked session ancestry and allows human status changes through the real HTTP routes", async () => {
    const app=Fastify();
    registerFolderRoutes(app,{
      provider:{listFolders:()=>[{id:'cards-a'}],listSessionAssignments:()=>({})},
      accessProvider:{resolveAccess:()=>({restricted:true,allowedFolderIds:['cards-a']})},
      resolveDashboardUserId:()=>human.actorUserId,cardServiceProvider:async()=>cards,
      authBearerToken:'service-test',environment:'production',
    });
    try {
      const created=await app.inject({method:'POST',url:'/api/cards',payload:{
        folderId:'cards-a',title:'상태 메뉴 계약',request:'원문',idempotencyKey:key(),
      }});
      expect(created.statusCode).toBe(201);
      const id=created.json().card.id;
      await h.sql`INSERT INTO sessions(session_id,folder_id,card_id,caller_session_id,updated_at)
        VALUES ('http-root','cards-a',${id},NULL,'2026-09-30T00:00:00Z'),
               ('http-child','cards-a',${id},'http-root','2026-09-30T01:00:00Z')`;
      const read=()=>app.inject(`/api/cards/${id}`);
      let response=await read();
      expect(response.statusCode).toBe(200);
      expect(response.json().sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({sessionId:'http-root',callerSessionId:null,updatedAt:'2026-09-30T00:00:00.000Z'}),
        expect.objectContaining({sessionId:'http-child',callerSessionId:'http-root',updatedAt:'2026-09-30T01:00:00.000Z'}),
      ]));
      for(const status of ['running','todo','done','cancelled']) {
        const changed=await app.inject({method:'POST',url:`/api/cards/${id}/status`,payload:{
          status,expectedVersion:response.json().card.version,idempotencyKey:key(),
        }});
        expect(changed.statusCode).toBe(200);
        response=await read();
        expect(response.json().card.status).toBe(status);
      }
      const rejected=await app.inject({method:'POST',url:`/api/cards/${id}/status`,payload:{
        status:'review',expectedVersion:response.json().card.version,idempotencyKey:key(),
      }});
      expect(rejected.statusCode).toBe(200);
      expect((await read()).json().card.status).toBe('review');
    } finally {await app.close();}
  });

  it("exposes review and every blocked kind in attention with running and globally ordered queued cards on today", async () => {
    await h.sql`INSERT INTO pages(id,title,daily_date,version) VALUES ('card-day','Today','2026-09-30',1),('card-page-a','A',NULL,1),('card-page-b','B',NULL,1)`;
    await h.sql`UPDATE folders SET project_page_id=CASE id WHEN 'cards-a' THEN 'card-page-a' ELSE 'card-page-b' END WHERE id IN ('cards-a','cards-b')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,status,blocked_kind) VALUES
      ('attention-review','cards-a','z1','Review','review',NULL),('attention-question','cards-a','z2','Question','blocked','question'),
      ('attention-report','cards-a','z3','No report','blocked','no_report'),('attention-limit','cards-a','z4','Limit','blocked','limit')`;
    const planner=new PlannerRepository(createLiveDbSqlResolver({ sql:h.liveSql }));
    const today=(await planner.getToday('2026-09-30'))!;
    expect(today.attention.filter(c=>typeof c.id === 'string' && c.id.startsWith('attention-')).map(c=>c.id).sort()).toEqual(['attention-limit','attention-question','attention-report','attention-review']);
    expect(today.running.length).toBeGreaterThan(0);
    expect(today.queued.map(c=>c.title)).toEqual(['둘째','첫']);
    expect((await planner.getFolder('cards-a',{limit:10}))!).toHaveProperty('cards');
  });
});
